#!/usr/bin/env node

'use strict';

var chalk = require('chalk');
var readline = require('readline');
var Swarm = require('./mdns-swarm.js');
var user = require('github-current-user');

var swarm = new Swarm('simple-swarm');

swarm.on('peer', function (stream, id) {
  console.log('connected to', id);

  stream.pipe(process.stdout);
});

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

user.verify(function (err, valid, username) {
  if (err || !valid) {
    return console.error("sorry, can't figure out your github username");
  }

  function format(message, mine) {
    var color = (mine ? chalk.red : chalk.blue);

    return color(username + '-' + swarm.port + ': ') + message + '\n';
  }

  function cli() {
    rl.question('> ', function (message) {
      if (message === '/exit') {
        return rl.close();
      }

      process.stdout.write(format(message, true));

      swarm.send(format(message));

      cli();
    });
  }

  cli();
});
