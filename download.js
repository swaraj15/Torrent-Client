//Contains all types of messages to be sent via TCP Connection
const Buffer = require('buffer').Buffer;
const net = require('net');
const tracker = require('./tracker');
const message = require('./message');
const Pieces = require('./Pieces');
const Queue = require('./Queue');
const fs = require('fs');
const tp = require('./torrent_parser');

module.exports.getMessageResponse = (torrent, path) =>{

  tracker.getPeers(torrent,peers => {
      const pieces = new Pieces(torrent);
      const file = fs.openSync(path, 'w');    //SCOPE FOR IMPROVEMENT: Multi-file tracker
      peers.forEach(peer => download(peer, torrent, pieces, file));   //peers.array.forEach means download will be called for each peer
  });
}

function download(peer, torrent, pieces, file){
  const socket = new net.Socket();
  socket.on('error', console.log);    //Catches the error and prints it (asynchronously)
  socket.connect(peer.port, peer.ip, () => {    //Establishing a TCP connection
    socket.write(message.buildHandshake(torrent));  //building a Handshake message
  });

  const queue = new Queue(torrent);   //Pieces each peer has is stores as a list
  OnWholeMessage(socket , msg => msgHandler(msg, socket, pieces, queue, file,torrent)); //Parsing the Message
}

function OnWholeMessage(socket, callback){
    let SavedBuf = Buffer.alloc(0);
    let HandShake = true;   //Only way to identify handshake message: it's the 1st messgae received. So set it to true and after 1st complete message read, turn it to false. 
  
    socket.on('data', RecvBuf=>{

        //Handshake is of 68 bytes & 1st byte contains 19 (protocol). So 19 + 49 = 68. Else first 4 bytes contain message length excluding the first 4 bytes. So length + 4. 
        SavedBuf = Buffer.concat([SavedBuf, RecvBuf]);
        const MessageLength = () => HandShake ? SavedBuf.readUInt8(0) + 49 : SavedBuf.readInt32BE(0) + 4;
        
        //Go inside this loop only when a complete message is received & then slice the complete message & pass it to callback. Then delete the complete message from saved buffer.
        while(SavedBuf.length >= 4 && SavedBuf.length >= MessageLength()){
            callback(SavedBuf.slice(0, MessageLength()));
            SavedBuf = SavedBuf.slice(MessageLength());
            HandShake = false;
        }
    });
}

function msgHandler(msg, socket, pieces, queue, file, torrent) {
    if (isHandshake(msg)){ 
        socket.write(message.buildInterested());
    }
    else {
        const m = message.parse(msg);   //parses the message
    
        if (m.id === 0) chokeHandler(socket);
        if (m.id === 1) unchokeHandler(socket, pieces, queue);
        if (m.id === 4) haveHandler(m.payload, socket, pieces, queue);
        if (m.id === 5) bitfieldHandler(socket, pieces, queue, m.payload);
        if (m.id === 7) pieceHandler(socket, pieces, queue, torrent, file, m.payload);
      
    }
    
}
  

function isHandshake(msg) {
    return msg.length === msg.readUInt8(0) + 49 && msg.toString('utf8', 1) === 'BitTorrent protocol';
  }

function haveHandler(payload, socket, pieces, queue){
    const pieceIndex = payload.readUInt32BE(0);
    const queueEmpty = queue.length === 0;
    queue.queue(pieceIndex);
    if (queueEmpty) requestPiece(socket, pieces, queue);
}

function pieceHandler(socket, pieces, queue, torrent, file, pieceResp) {

  pieces.addReceived(pieceResp);

  const offset = pieceResp.index * torrent.info['piece length'] + pieceResp.begin;
  fs.write(file, pieceResp.block, 0, pieceResp.block.length, offset, () => {});

  if (pieces.isDone()) {
    console.log('DONE!');
    socket.end();
    try { fs.closeSync(file); } catch(e) {}
  } else {
    requestPiece(socket, pieces, queue);
  }

}

function requestPiece(socket, pieces, queue) {
  if (queue.choked) return null;

  while (queue.length()) {
    const pieceBlock = queue.deque();
    if (pieces.needed(pieceBlock)) {
      socket.write(message.buildRequest(pieceBlock));
      pieces.addRequested(pieceBlock);
      break;
    } 
  }
}

function chokeHandler(socket){console.log("choked");
  socket.end();
}

function unchokeHandler(socket, pieces, queue){
  queue.choked = false;
  requestPiece(socket, pieces, queue);
}


function bitfieldHandler(socket, pieces, queue, payload) {
  const queueEmpty = queue.length === 0;
  payload.forEach((byte, i) => {
    for (let j = 0; j < 8; j++) {
      if (byte % 2) queue.queue(i * 8 + 7 - j);
      byte = Math.floor(byte / 2);
    }
  });
  if (queueEmpty) requestPiece(socket, pieces, queue);
}