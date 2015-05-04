'use strict';

var async = require('async');
var cuid = require('cuid');
var debug = require('debug');
var events = require('events');
var ip = require('ipv6');
var once = require('once');
var request = require('request');
var Service = require('./dns-sd.js').Service;
var signalServer = require('./signal-server.js');
var SimplePeer = require('simple-peer');
var util = require('util');
// var _ = require('lodash');

function Swarm(identifier, channel, simplePeerOptions) {
  events.EventEmitter.call(this);

  this.debug = debug(['mdns-swarm', identifier, channel].join(':'));

  this.identifier = identifier;
  this.channel = channel;

  this.service = new Service(identifier);

  this.simplePeerOptions = simplePeerOptions || {};

  this.peers = [];
  this._peers = {};

  this.signalQueue = {};
  this.connectivity = {};

  // a fingerprint of this host/process
  this.id = cuid();

  this.connectivityQueue = async.queue(function (task, cb) {
    task(cb);
  }, 1);

  var self = this;

  this.on('connectivity', function (host, baseUrl) {
    self.debug('connectivity for %s: %s', host, baseUrl);

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

Swarm.prototype.advertise = function () {
  var self = this;

  var app = signalServer.listen.call(this, function onListening(port) {
    self.service.advertise(port, {
      host: self.id,
      channel: self.channel
    });
  }, function onSignal(host, signal) {
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

  this.service.on('service', function (service) {
    if (!service.host || !service.channel) {
      self.debug('could not find host and/or channel in %j', service);

      return;
    }

    if (service.host === self.id || service.channel !== self.channel) {
      return;
    }

    self.debug('service %s:%s, %s, %s, %j',
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

          self.connectivity[service.host] = hostBase;

          self.emit('connectivity', service.host, hostBase);

          cb();
        });
      });
    });
  });

  this.service.browse();
};

module.exports = Swarm;
