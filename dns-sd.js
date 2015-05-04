'use strict';

var debug = require('debug');
var events = require('events');
var ip = require('ipv6');
var multicastdns = require('multicast-dns');
var os = require('os');
var util = require('util');
var _ = require('lodash');

var ADVERTISE_INTERVAL = 10 * 1000;
var QUERY_INTERVAL = 10 * 1000;

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

function Service(name) {
  events.EventEmitter.call(this);

  this.debug = debug(['dns-sd', name].join(':'));

  this.name = name;
  this.hostname = os.hostname();

  this.mdnsName = '_' + name + '._tcp.local';
  this.mdnsHostname = this.hostname + '.' + this.mdnsName;

  this.mdns4 = multicastdns();
  // XXX: specifying the address scope is not optional
  this.mdns6 = multicastdns({type: 'udp6', ip: 'ff02::fb%en0'});

  var self = this;

  function warning(err) {
    self.debug('multicast-dns error: %j', err);
  }

  this.mdns4.on('warning', warning);
  this.mdns6.on('warning', warning);

  function ready() {
    self.debug('multicast-dns ready');
  }

  this.mdns4.on('ready', ready);
  this.mdns6.on('ready', ready);
}

util.inherits(Service, events.EventEmitter);

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

    var packet = {
      answers: [{
        name: self.mdnsHostname,
        type: 'SRV',
        data: {
          target: self.hostname + '.local',
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
      additionals: getAddresses(self.hostname + '.local')
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
  // this.mdns6.on('query', onQuery);

  advertise();

  setInterval(advertise, ADVERTISE_INTERVAL);

  this.debug('advertising %s:%d: %j', this.name, port, data);
};

exports.Service = Service;
