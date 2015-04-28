'use strict';

var async = require('async');
var cuid = require('cuid');
var debug = require('debug')('mdns-swarm');
var events = require('events');
var ip = require('ipv6');
var mdns = require('mdns');
var once = require('once');
var request = require('request');
var SimplePeer = require('simple-peer');
var signalServer = require('./signal-server.js');
var util = require('util');

function Swarm(identifier, swarmOptions) {
  events.EventEmitter.call(this);

  this.swarmOptions = swarmOptions || {};

  this.peers = [];
  this._peers = {};

  this.connectivity = {};

  // a fingerprint of this host/process
  this.id = cuid();

  this.connectivityQueue = async.queue(function (task, cb) {
    task(cb);
  }, 1);

  var self = this;

  var app = signalServer.listen(this.id, function onListening(port) {
    var advertisement = mdns.createAdvertisement(
      mdns.tcp(identifier),
      port,
      {txtRecord: {host: self.id}});

    advertisement.on('error', function (err) {
      console.error('advertisement error', err);
    });

    advertisement.start();

    debug('advertising %s, %s', identifier, self.id);
  }, function onSignal(host, signal) {
    debug('signal from %s, %s', host, signal.type || 'no type');

    if (!self._peers[host]) {
      return debug('no peer for host %s', host);
    }

    self._peers[host].signal(signal);
  });

  if (process.env.DEBUG) {
    require('./debug-routes.js').call(this, app);
  }

  var browser = mdns.createBrowser(mdns.tcp(identifier));

  browser.on('error', function (err) {
    console.error('browser error', err);
  });

  browser.on('serviceUp', function (service) {
    var host = service.txtRecord && service.txtRecord.host;

    if (!host) {
      debug('skipping, no host');

      return;
    }

    if (self.id === host) {
      return;
    }

    debug('service up %j, %s, %s, %s', service.addresses, service.host,
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
            debug('using hostname in favor of scoped IPv6 address');

            hostBase = 'http://' + service.host + ':' + service.port + '/';
          } else {
            hostBase = v6.href(service.port);
          }
        } else {
          hostBase = 'http://' + address + ':' + service.port + '/';
        }

        var url = hostBase + 'connectivity';

        debug('→ GET %s', url);

        request.get({url: url, json: true}, function (err, response, body) {
          if (err) {
            console.error('→ GET err /connectivity', err);

            return cb();
          }

          if (body.host !== host) {
            console.error('→ GET /connectivity host mismatch', body.host,
              '!==', host);

            return cb();
          }

          debug('host %s is accessible via %s', host, hostBase);

          self.connectivity[host] = hostBase;

          self.emit('connectivity', host, hostBase);

          debug('reponse %s', response.statusCode);

          cb();
        });
      });
    });
  });

  this.on('connectivity', function (host, baseUrl) {
    debug('connectivity event from %s, %s', host, baseUrl);

    var options = {wrtc: self.swarmOptions.wrtc};

    // only connect to hosts with IDs that sort higher
    if (self.id < host) {
      options.initiator = true;
    }

    var peer = this._peers[host] = new SimplePeer(options);

    peer.on('signal', function (signal) {
      var url = baseUrl + 'signal/' + self.id;

      debug('→ POST: %s', url);

      request.post({
        url: url,
        json: true,
        body: signal
      }, function (err, response) {
        if (err || response.statusCode !== 200) {
          console.error('→ POST err /signal/' + self.id, err,
            response && response.statusCode);
        }
      });
    });

    peer.on('connect', function () {
      debug('connected to host %s', host);

      self.peers.push(peer);

      self.emit('peer', peer, host);
      self.emit('connection', peer, host);
    });

    var onClose = once(function () {
      debug('peer close %s', host);

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

  // XXX: the metadata we get here is not specific enough to do anything with
  // browser.on('serviceDown', function (service) {
  //   debug('peer-gone', service);
  // });

  browser.start();
}

util.inherits(Swarm, events.EventEmitter);

// Swarm.prototype.send = function (message) {
//   this.peers.forEach(function (peer) {
//     peer.send(message);
//   });
// };

module.exports = Swarm;
