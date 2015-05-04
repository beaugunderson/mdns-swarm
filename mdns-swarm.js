'use strict';

var async = require('async');
var cuid = require('cuid');
var debug = require('debug');
var events = require('events');
var ip = require('ipv6');
var multicastdns = require('multicast-dns');
var once = require('once');
var os = require('os');
var request = require('request');
var SimplePeer = require('simple-peer');
var signalServer = require('./signal-server.js');
var util = require('util');
var _ = require('lodash');

var ADVERTISE_INTERVAL = 10 * 1000;
var QUERY_INTERVAL = 10 * 1000;

function Swarm(identifier, channel, simplePeerOptions) {
  events.EventEmitter.call(this);

  this.debug = debug(['mdns-swarm', identifier, channel].join(':'));

  this.hostname = os.hostname() + '.local';

  // XXX: mDNS name to be <= 15 characters
  this.identifier = identifier;
  this.channel = channel;

  this.mdnsIdentifier = '_' + this.identifier + '._tcp.local';
  this.mdnsHostIdentifier = this.hostname + '.' + this.mdnsIdentifier;

  this.simplePeerOptions = simplePeerOptions || {};

  this.peers = [];
  this._peers = {};

  this.signalQueue = {};
  this.connectivity = {};

  this.mdns = multicastdns();

  // a fingerprint of this host/process
  this.id = cuid();

  this.connectivityQueue = async.queue(function (task, cb) {
    task(cb);
  }, 1);

  var self = this;

  this.on('connectivity', function (host, baseUrl) {
    self.debug('connectivity event from %s, %s', host, baseUrl);

    // TODO: use _.extend here if there are other options that can be passed
    var options = {wrtc: self.simplePeerOptions.wrtc};

    // only connect to hosts with IDs that sort higher
    if (self.id < host) {
      options.initiator = true;
    }

    var peer = this._peers[host] = new SimplePeer(options);

    peer.on('signal', function (signal) {
      var url = baseUrl + 'signal/' + self.id;

      self.debug('→ POST: %s', url);

      request.post({
        url: url,
        json: true,
        body: signal
      }, function (err, response) {
        if (err || response.statusCode !== 200) {
          console.error('→ POST err /signal/' + self.id + ': ' + err + ' ' +
            (response && response.statusCode));
        }
      });
    });

    peer.on('connect', function () {
      self.debug('connected to host %s', host);

      self.peers.push(peer);

      self.emit('peer', peer, host);
      self.emit('connection', peer, host);
    });

    var onClose = once(function () {
      self.debug('peer close %s', host);

      if (self._peers[host] === peer) {
        delete self._peers[host];
      }

      var i = self.peers.indexOf(peer);

      if (i > -1) {
        self.peers.splice(i, 1);
      }
    });

    peer.on('error', onClose);
    peer.once('close', onClose);

    if (self.signalQueue[host]) {
      self.debug('host %s has %d queued signals', host,
        self.signalQueue[host].length);

      var queuedSignal;

      while ((queuedSignal = self.signalQueue[host].shift())) {
        self.debug('applying queued signal for %s', host);

        peer.signal(queuedSignal);
      }
    }
  });

  this.advertise();
  this.browse();
}

util.inherits(Swarm, events.EventEmitter);

// TODO: sort these based on local -> remote?
function getAddresses(hostname) {
  var addresses = _(os.networkInterfaces()).map(function (value) {
    return value;
  })
  .flatten()
  .filter(function (address) {
    return !address.internal;
  }).valueOf();

  var addresses4 = addresses.filter(function (address) {
    return address.family === 'IPv4';
  }).map(function (address) {
    return {
      name: hostname,
      type: 'A',
      data: address.address
    };
  });

  var addresses6 = addresses.filter(function (address) {
    if (address.family !== 'IPv6') {
      return false;
    }

    var v6 = new ip.v6.Address(address.address);

    return v6.isValid() && v6.getScope() === 'Global';
  }).map(function (address) {
    return {
      name: hostname,
      type: 'AAAA',
      data: address.address
    };
  });

  return addresses6.concat(addresses4);
}

Swarm.prototype.advertise = function () {
  var self = this;

  var app = signalServer.listen.call(this, function onListening(port) {
    function advertise() {
      var data = [
        'host=' + self.id,
        'channel=' + self.channel
      ];

      // TXT records store key/value pairs preceeded by a single byte
      // specifying their length
      data = data.map(function (d) {
        return String.fromCharCode(d.length) + d;
      }).join('');

      var packet = {
        answers: [{
          name: self.mdnsHostIdentifier,
          type: 'SRV',
          data: {
            target: self.hostname,
            port: port
          }
        }, {
          name: self.mdnsHostIdentifier,
          type: 'TXT',
          data: data
        }, {
          name: self.mdnsIdentifier,
          type: 'PTR',
          data: self.mdnsHostIdentifier
        }, {
          name: '_services._dns-sd._udp.local',
          type: 'PTR',
          data: self.mdnsIdentifier
        }],
        additionals: getAddresses(self.hostname)
      };

      self.mdns.respond(packet);
    }

    self.mdns.on('query', function (query, requestInfo) {
      if (!_.any(query.questions, function (question) {
        return question.type === 'SRV' && question.name === self.mdnsIdentifier;
      })) {
        return;
      }

      self.debug('request for SRV %s from %j', self.mdnsIdentifier, requestInfo);

      advertise();
    });

    advertise();

    setInterval(advertise, ADVERTISE_INTERVAL);

    self.debug('%s advertising %s:%s', self.identifier, self.id, port);
  }, function onSignal(host, signal) {
    // TODO: queue signals for this peer and send them when we find out about it
    // (within 5 minutes?)
    if (!self._peers[host]) {
      if (!self.signalQueue[host]) {
        self.signalQueue[host] = [];
      }

      self.debug('queuing signal for host %s', host);

      self.signalQueue[host].push(signal);

      return;
    }

    self._peers[host].signal(signal);
  });

  if (process.env.DEBUG) {
    require('./debug-routes.js').call(this, app);
  }
};

Swarm.prototype.browse = function () {
  var self = this;

  this.mdns.on('response', function (packet) {
    // self.debug('response from %j', requestInfo);

    // TODO: abstract all of this to a dns-sd library built on top of
    // multicast-dns
    var answers = (packet.answers || []).concat(packet.additionals || []);

    var servicePointer = _.find(answers, function (answer) {
      return answer.type === 'PTR' && answer.name === self.mdnsIdentifier;
    });

    if (!servicePointer) {
      return;
    }

    var serviceService = _.find(answers, function (answer) {
      return answer.type === 'SRV' && answer.name === servicePointer.data;
    });

    if (!serviceService) {
      return;
    }

    var serviceText = _.find(answers, function (answer) {
      return answer.type === 'TXT' && answer.name === servicePointer.data;
    });

    if (!serviceText) {
      return;
    }

    var text = serviceText.data.split('');
    var attrs = [];

    while (text.length) {
      // XXX: not strictly conforming, doesn't handle quoted keys
      attrs.push(text.splice(0, text.splice(0, 1)[0].charCodeAt(0))
        .join('')
        .split('='));
    }

    var service = _.zipObject(attrs);

    if (!service.host || !service.channel) {
      self.debug('could not find host and/or channel in %j', service);

      return;
    }

    if (service.host === self.id || service.channel !== self.channel) {
      return;
    }

    service.port = serviceService.data.port;
    service.hostname = serviceService.data.target;

    service.addresses = _(answers).filter(function (answer) {
        return answer.type === 'A' || answer.type === 'AAAA';
      })
      .pluck('data')
      .valueOf();

    self.debug('service up %s:%s, %s, %s, %j',
      service.host,
      service.channel,
      service.hostname,
      service.port,
      service.addresses);

    service.addresses.forEach(function (address) {
      self.connectivityQueue.push(function (cb) {
        if (self.connectivity[service.host]) {
          return cb();
        }

        var v6 = new ip.v6.Address(address);

        var hostBase;

        if (v6.isValid()) {
          if (v6.getScope() !== 'Global') {
            self.debug('using hostname in favor of scoped IPv6 address');

            hostBase = 'http://' + service.hostname + ':' + service.port + '/';
          } else {
            hostBase = v6.href(service.port);
          }
        } else {
          hostBase = 'http://' + address + ':' + service.port + '/';
        }

        var url = hostBase + 'connectivity';

        self.debug('→ GET %s', url);

        request.get({url: url, json: true}, function (err, response, body) {
          if (err) {
            console.error('→ GET err /connectivity: ' + err);

            return cb();
          }

          if (body.host !== service.host) {
            console.error('→ GET /connectivity host mismatch: ' + body.host +
              ' !== ' + service.host);

            return cb();
          }

          self.debug('host %s is accessible via %s', service.host, hostBase);

          self.connectivity[service.host] = hostBase;

          self.emit('connectivity', service.host, hostBase);

          cb();
        });
      });
    });
  });

  function query() {
    self.mdns.query(self.identifier + '._tcp.local', 'SRV');
  }

  query();

  setInterval(query, QUERY_INTERVAL);
};

module.exports = Swarm;
