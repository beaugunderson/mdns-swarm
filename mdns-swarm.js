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
var wrtc = require('wrtc');
var _ = require('lodash');

// a fingerprint of the user's machine
var me = cuid();

function Swarm(identifier) {
  events.EventEmitter.call(this);

  this.peers = [];
  this._peers = {};

  this.connectivity = {};

  this.connectivityQueue = async.queue(function (task, cb) {
    task(cb);
  }, 1);

  var self = this;

  this.on('connectivity', function (host, baseUrl) {
    debug('connectivity event', host, baseUrl);

    var options = {};

    if (me < host) {
      options = {initiator: true};
    }

    var peer = this._peers[host] = new SimplePeer(_.defaults(options, {wrtc: wrtc}));

    peer.on('signal', function (signal) {
      var url = baseUrl + 'signal/' + me;

      debug('→ POST', url);

      request.post({
        url: url,
        json: true,
        body: signal
      }, function (err, response) {
        if (err || response.statusCode !== 200) {
          console.error('→ POST err /signal/' + me, err,
            response && response.statusCode);
        }
      });
    });

    peer.on('connect', function () {
      debug('connected to host', host);

      self.peers.push(peer);

      self.emit('peer', peer, host);
      self.emit('connection', peer, host);
    });

    var onClose = once(function () {
      debug('peer close', host);

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

  var app = signalServer.listen(me, function onListening(port) {
    var advertisement = mdns.createAdvertisement(
      mdns.tcp(identifier),
      port,
      {txtRecord: {host: me}});

    advertisement.on('error', function (err) {
      console.error('advertisement error', err);
    });

    advertisement.start();

    debug('advertising', identifier, me);
  }, function onSignal(host, signal) {
    debug('signal from', host, signal.type);

    if (!self._peers[host]) {
      return debug('no peer for host', host);
    }

    self._peers[host].signal(signal);
  });

  if (process.env.DEBUG) {
    app.get('/debug', function (req, res) {
      var hosts = _.keys(self._peers);

      var connections = hosts.map(function (host) {
        return self.connectivity[host];
      });

      var mine = _.zipObject(hosts, connections);

      if (req.query.all) {
        debug('← GET /debug?all=true');

        async.map(hosts, function (host, cbMap) {
          debug('→ GET /debug', host);

          request.get({
            url: self.connectivity[host] + 'debug',
            json: true
          }, function (err, response, body) {
            var result = {host: host};

            if (err || !body) {
              result.connections = self.connectivity[host];
            } else {
              result.connections = body;
            }

            cbMap(null, result);
          });
        }, function (err, results) {
          if (err) {
            return res.send({error: err});
          }

          var resultsObject = _.zipObject(_.pluck(results, 'host'),
                                          _.pluck(results, 'connections'));


          resultsObject[me] = mine;

          res.send(resultsObject);
        });

        return;
      }

      debug('← GET /debug');

      res.send(mine);
    });
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

    if (me === host) {
      return;
    }

    debug('service up', service.addresses, service.host, service.port, host);

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

        debug('→ GET', url);

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

          debug('host', host, 'is accessible via', hostBase);

          self.connectivity[host] = hostBase;

          self.emit('connectivity', host, hostBase);

          debug('reponse', response.statusCode);

          cb();
        });
      });
    });
  });

  // XXX: the metadata we get here is not specific enough to do anything with
  // browser.on('serviceDown', function (service) {
  //   debug('peer-gone', service);
  // });

  browser.start();
}

util.inherits(Swarm, events.EventEmitter);

Swarm.prototype.send = function (message) {
  this.peers.forEach(function (peer) {
    peer.send(message);
  });
};

module.exports = Swarm;
