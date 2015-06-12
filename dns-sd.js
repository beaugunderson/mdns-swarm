'use strict';

var debug = require('debug');
var mainDebug = require('debug')('dns-sd');
var events = require('events');
var ip = require('ip-address');
var multicastdns = require('multicast-dns');
var network = require('network');
var os = require('os');
var util = require('util');
var _ = require('lodash');

var ADVERTISE_INTERVAL = 4.9 * 1000;
var QUERY_INTERVAL = 4.9 * 1000;

// TODO: sort these based on local -> remote?
function getAddresses(hostname) {
  var addresses = _(os.networkInterfaces()).map(function (value) {
      return value;
    })
    .flatten()
    .filter(function (address) {
      return !address.internal;
    })
    .valueOf();

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

    return v6.isValid() &&
      (v6.getScope() === 'Global' || v6.getScope() === 'Reserved');
  }).map(function (address) {
    return {
      name: hostname,
      type: 'AAAA',
      data: address.address
    };
  }).sort(function (a, b) {
    // Prioritize link-local unicast addresses first
    var x = a.data;
    var y = b.data;

    if (x.indexOf('fe80') === 0) {
      x = ' ' + x;
    }

    if (y.indexOf('fe80') === 0) {
      y = ' ' + y;
    }

    return x.localeCompare(y);
  });

  mainDebug('addresses6 %j', addresses6);

  return addresses6.concat(addresses4);
}

function Service(name) {
  events.EventEmitter.call(this);

  this.debug = debug(['dns-sd', name].join(':'));

  this.name = name;
  this.hostname = os.hostname();

  this.mdnsName = '_' + name + '._tcp.local';
  this.mdnsHostname = this.hostname + '.' + this.mdnsName;
}

util.inherits(Service, events.EventEmitter);

Service.prototype.initialize = function (cb) {
  var self = this;

  function ready() {
    self.debug('multicast-dns ready');
  }

  function warning(err) {
    self.debug('multicast-dns warning: %j', err);
  }

  this.mdns4 = multicastdns();

  this.mdns4.on('warning', warning);
  this.mdns4.on('ready', ready);

  // TODO: allow overriding
  // TODO: different module for this?
  network.get_active_interface(function (err, activeInterface) {
    if (err) {
      self.debug('failed to find active network interface');

      return cb();
    }

    var activeAddresses = os.networkInterfaces()[activeInterface.name]
      .filter(function (address) {
        return address.family === 'IPv6';
      });

    if (!activeAddresses.length) {
      self.debug('failed to find IPv6 address for interface %s',
        activeInterface.name);

      return cb();
    }

    self.debug('using IPv6 interface "%s" and address "%s"',
      activeAddresses[0].address, activeInterface.name);

    self.mdns6 = multicastdns({
      type: 'udp6',
      interface: activeAddresses[0].address + '%' + activeInterface.name,
      ip: 'ff02::fb%' + activeInterface.name
    });

    self.mdns6.on('warning', warning);
    self.mdns6.on('ready', ready);

    cb();
  });
};

Service.prototype.browse = function () {
  var self = this;

  function onResponse(packet) {
    var answers = (packet.answers || []).concat(packet.additionals || []);

    var servicePointer = _.find(answers, function (answer) {
      return answer.type === 'PTR' && answer.name === self.mdnsName;
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

    service.port = serviceService.data.port;
    service.hostname = serviceService.data.target;

    if (serviceService.name === self.mdnsHostname &&
        service.port === self.port) {
      self.debug('skipping my own service');

      return;
    }

    service.addresses = _(answers).filter(function (answer) {
        return answer.type === 'A' || answer.type === 'AAAA';
      })
      .pluck('data')
      .valueOf();

    self.debug('emitting service %j', service);

    self.emit('service', service);
  }

  this.mdns4.on('response', onResponse);
  this.mdns6.on('response', onResponse);

  function query() {
    self.mdns4.query(self.mdnsName, 'SRV');
    self.mdns6.query(self.mdnsName, 'SRV');
  }

  query();

  setInterval(query, QUERY_INTERVAL);
};

Service.prototype.advertise = function (port, data) {
  this.port = port;

  var self = this;

  function advertise() {
    self.debug('advertising response');

    // TXT records store key/value pairs preceeded by a single byte
    // specifying their length
    var txt = _.map(data, function (value, key) {
        return key + '=' + value;
      })
      .map(function (attr) {
        return String.fromCharCode(attr.length) + attr;
      })
      .join('');

    var hostname = self.hostname.replace(/\.local$/, '') + '.local';

    var packet = {
      answers: [{
        name: self.mdnsHostname,
        type: 'SRV',
        data: {
          target: hostname,
          port: port
        }
      }, {
        name: self.mdnsHostname,
        type: 'TXT',
        data: txt
      }, {
        name: self.mdnsName,
        type: 'PTR',
        data: self.mdnsHostname
      }, {
        name: '_services._dns-sd._udp.local',
        type: 'PTR',
        data: self.mdnsName
      }],
      additionals: getAddresses(hostname)
    };

    function cb() {
      // console.log('XXX', err, result);
    }

    self.mdns4.respond(packet, cb);
    self.mdns6.respond(packet, cb);
  }

  function questionForMe(question) {
    return question.type === 'SRV' && question.name === self.mdnsName;
  }

  function onQuery(query, requestInfo) {
    if (!_.any(query.questions, questionForMe)) {
      return;
    }

    // TODO: ignore our own requests, but how?

    self.debug('request for SRV %s from %j', self.mdnsName,
      requestInfo);

    advertise();
  }

  this.mdns4.on('query', onQuery);
  this.mdns6.on('query', onQuery);

  advertise();

  setInterval(advertise, ADVERTISE_INTERVAL);

  this.debug('advertising %s:%d: %j', this.name, port, data);
};

exports.Service = Service;
