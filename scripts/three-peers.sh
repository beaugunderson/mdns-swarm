#!/bin/bash

./one-peer.sh &> 1.log &
PEER_1=$!

./one-peer.sh &> 2.log &
PEER_2=$!

./one-peer.sh &> 3.log &
PEER_3=$!

echo "pids: $PEER_1 $PEER_2 $PEER_3"

multitail -cT ANSI 1.log \
  -cT ANSI 2.log \
  -cT ANSI 3.log

echo "killing..."

# TODO: actually get the pids from the subshell so we can kill those
pgrep -f "node ../simple-swarm.js" | xargs kill
