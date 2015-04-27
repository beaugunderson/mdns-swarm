'use strict';

var debug = require('debug')('mdns-swarm');
var events = require('events');
var mdns = require('mdns');
var net = require('net');
var os = require('os');
var util = require('util');

function Server(cb, connectionCb) {
  var self = this;

  var server = net.createServer(function (c) {
    console.log('new client conection from', c.remoteAddress + ':' +
      c.remotePort);

    c.on('end', function () {
      console.log('disconnected from', c.remoteAddress + ':' + c.remotePort);
    });

    c.pipe(process.stdout);

    connectionCb(c);
  });

  server.listen(0, function () {
    self.address = server.address();

    cb(self.address);
  });

  server.on('error', function (err) {
    console.error('server error', err);
  });
}

function id(host, port) {
  if (!host) {
    host = 'unknown';
  } else if (host[host.length - 1] !== '.') {
    host += '.';
  }

  return host + ':' + port;
}

// function idFromService(service) {
//   return id(service.host, service.port);
// }

function Swarm(identifier, optionalCb) {
  events.EventEmitter.call(this);

  this.hostname = os.hostname();
  this.peers = [];

  var self = this;

  this.server = new Server(function listening(address) {
    var advertisement = mdns.createAdvertisement(mdns.tcp(identifier),
       address.port);

    self.port = address.port;
    self.id = id(self.hostname, address.port);

    console.log('advertising at', self.id);

    advertisement.on('error', function (err) {
      console.log('advertisement error', err);
    });

    advertisement.start();

    if (optionalCb) {
      optionalCb();
    }
  }, function connection(client) {
    self.peers.push(client);
  });

  var browser = mdns.createBrowser(mdns.tcp(identifier));

  browser.on('error', function (err) {
    console.log('browser error', err);
  });

  browser.on('serviceUp', function (service) {
    var serviceId = id(service.host, service.port);

    console.log('service up', serviceId);

    if (self.id === serviceId) {
      return debug('not connecting to my own advertisement');
    }

    if (self.id > serviceId) {
      return debug('not connecting to a lower-id host');
    }

    var client = net.connect({
      port: service.port,
      family: service.family,
      host: service.host
    });

    client.on('connect', function () {
      self.emit('peer', client, serviceId);
    });

    client.on('error', function (err) {
      console.error('client error', err);
    });

    self.peers.push(client);
  });

  // browser.on('serviceDown', function (service) {
  //   self.emit('peer-gone', service, idFromService(service));
  // });

  browser.start();
}

util.inherits(Swarm, events.EventEmitter);

Swarm.prototype.send = function (message) {
  this.peers.forEach(function (peer) {
    peer.write(message);
  });
};

module.exports = Swarm;
