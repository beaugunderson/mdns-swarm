'use strict';

var async = require('async');
var cuid = require('cuid');
var debug = require('debug');
var events = require('events');
var ip = require('ipv6');
var mdns = require('mdns');
var once = require('once');
var request = require('request');
var SimplePeer = require('simple-peer');
var signalServer = require('./signal-server.js');
var util = require('util');

function Swarm(identifier, simplePeerOptions) {
  events.EventEmitter.call(this);

  this.debug = debug('mdns-swarm:' + identifier);

  this.identifier = identifier;

  this.simplePeerOptions = simplePeerOptions || {};

  this.peers = [];
  this._peers = {};

  this.connectivity = {};

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
  });

  this.advertise();
  this.browse();
}

util.inherits(Swarm, events.EventEmitter);

Swarm.prototype.advertise = function () {
  var self = this;

  var app = signalServer.listen.call(this, function onListening(port) {
    var advertisement = mdns.createAdvertisement(
      mdns.tcp(self.identifier),
      port,
      {txtRecord: {host: self.id}});

    advertisement.on('error', function (err) {
      console.error('advertisement error: ' + err);
    });

    advertisement.start();

    self.debug('%s advertising %s:%s', self.identifier, self.id, port);
  }, function onSignal(host, signal) {
    // TODO: queue signals for this peer and send them when we find out about it
    // (within 5 minutes?)
    if (!self._peers[host]) {
      return self.debug('no peer for host %s', host);
    }

    self._peers[host].signal(signal);
  });

  if (process.env.DEBUG) {
    require('./debug-routes.js').call(this, app);
  }
};

Swarm.prototype.browse = function () {
  var browser = mdns.createBrowser(mdns.tcp(this.identifier));

  var self = this;

  browser.on('error', function (err) {
    console.error('browser error: ' + err);
  });

  browser.on('serviceUp', function (service) {
    var host = service.txtRecord && service.txtRecord.host;

    if (!host) {
      self.debug('skipping, no host');

      return;
    }

    if (self.id === host) {
      return;
    }

    self.debug('service up %j, %s, %s, %s', service.addresses, service.host,
      service.port, host);

    service.addresses.forEach(function (address) {
      self.connectivityQueue.push(function (cb) {
        if (self.connectivity[host]) {
          return cb();
        }

        var v6 = new ip.v6.Address(address);

        var hostBase;

        if (v6.isValid()) {
          if (v6.getScope() !== 'Global') {
            self.debug('using hostname in favor of scoped IPv6 address');

            hostBase = 'http://' + service.host + ':' + service.port + '/';
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

          if (body.host !== host) {
            console.error('→ GET /connectivity host mismatch: ' + body.host +
              ' !== ' + host);

            return cb();
          }

          self.debug('host %s is accessible via %s', host, hostBase);

          self.connectivity[host] = hostBase;

          self.emit('connectivity', host, hostBase);

          cb();
        });
      });
    });
  });

  browser.start();
};

module.exports = Swarm;
