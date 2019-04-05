const EventEmitter = require('events').EventEmitter;

const WebSocket = require('ws');
const serverMessages = require('./serverMessages.js');

const axios = require('axios');
const _ = require('lodash');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class CommChannel extends EventEmitter {
  constructor(connectionOptions, shuffleRoundInstance) {
    super();
    // this.emit('debug', {message:'setup', this: this});
    // Persist client options 
    for (let oneOption in connectionOptions) {
      this[oneOption] = connectionOptions[oneOption];
    }

    this.serverUri = connectionOptions.serverUri;

    if (!this.serverUri) {
      let connectionError = new Error('BAD_SERVER_URI');
      this.emit('connectionError', connectionError );
    }

    // Our Websocket client lives here
    this._wsClient = undefined;

    this.msg = serverMessages;

    this.round = shuffleRoundInstance;

    // Our internal records for sent
    // and received server messages.
    // Used for debugging bad rounds.
    this.outbox = {
      sent : {}
    };
    this.inbox = {};

    return this;

  }

  // Establish websockets connection with shuffle server.
  async connect() {

    // This and all communication functionality
    // will be moved to a separate class. The `Round`
    // should only touch messages after they have been
    // Parsed, validated, and classified.
    this._wsClient = new WebSocket(this.serverUri, {
      origin: 'http://localhost'
    });

    // When a message is received from the CashShuffle Server
    this._wsClient.on('message', (someMessageBuffer) => {

      let message = this.msg.decodeAndClassify(someMessageBuffer);

      // Add the message to our inbox in case we need it later
      let inboxEntry = [ {
        messageType: message.pruned.messageType,
        time: new Date().getTime(),
        protobuffMessage: {
          unpacked: message.full,
          components: message.components
        }
      } ];

      this.inbox[message.pruned.messageType] = this.inbox[message.pruned.messageType] ? _.sortBy(this.inbox[message.pruned.messageType].concat(inboxEntry), ['time'], ['desc']) : inboxEntry;

      console.log('\n\nA New Message has arrived', require('util').inspect(message.pruned, null, 4) ,'\n');
      // console.log('\n\nA New Message has arrived!\n');

      for (let onePacket of message.packets) {

        if (onePacket.signature) {
          let sender = _.find(this.round.players, { verificationKey: onePacket.packet.fromKey.key });
          console.log('Checking signature for', message.pruned.messageType.toUpperCase(), 'message from' , sender.session, '(', sender.verificationKey, ')' );

          if (!this.msg.checkPacketSignature(onePacket)) {
            console.log('\n\tSignature check failed!\n');

            this.emit('protocolViolation', {
              violation: 'BADSIG',
              culprit: sender,
              msg: message.pruned
            });

          }

          else {
            console.log('\n\tSignature checks out!\n');
            this.emit('serverMessage', message.pruned);
          }

        }

        // The signature doesn't need to be verified.
        else {
            this.emit('serverMessage', message.pruned);
        }
        
      }

    });

    // When the websockets connection is established with the CashShuffle server
    this._wsClient.on('open', () => {

      this._wsConnected = true;
      console.log('We are now connected to the cashshuffle server', this.serverUri);

      // this.emit('debug', {
      //   message: 'websocket-connected'
      //   // round: this
      // });

      this.emit('connected', this._wsClient);

    });

    // When the websockets connection is closed for any reason
    this._wsClient.on('close', (details) => {
      this.emit('disconnected', details);
    });

    // Handle websockets errors
    this._wsClient.on('error', (someErrorMessage) => {
      let connectionError = new Error('COMMS_ERR');
      connectionError.message = someErrorMessage.message || 'unknown error';
      this.emit('connectionError', connectionError );
    });

  }

  sendMessage() {

    let messageType = arguments[0];

    let messageParams = [].slice.call(arguments, 1, );

    console.log('\n\nNow sending message:', messageType, '\n\n');

    let packedMessage;
    if (messageType && typeof this.msg[messageType] === 'function') {
      try {
        packedMessage = this.msg[messageType].apply(this, messageParams );
      }
      catch(nope) {
        console.log('Couldnt create', messageType, 'message using params', messageParams, '\n', nope);
        // TODO: Throw exception?
      }
    }
    else {
      // TODO: Should we throw an exception now?
    }

    // Add the message to our outbox in case we need it later
    let outboxEntry = {
      messageType: messageType,
      time: new Date().getTime(),
      protobuffMessage: {
        // packed: packedMessage.packed.toString('base64'),
        unpacked: packedMessage.unpacked.toJSON(),
        components: packedMessage.components
      }
    };

    if (!this.outbox[messageType]) {
      let obj = {};
      obj[messageType] = [];
      _.extend(this.outbox, obj);
    }

    this.outbox.sent[messageType] = true;
    this.outbox[messageType].push(outboxEntry);

    this._wsClient.send(packedMessage.packed);

  }

  writeDebugFile() {

    for (let oneKey in this.inbox) {
      if (_.isArray(this.inbox[oneKey])) {
        this.inbox[oneKey] =  _.sortBy(this.inbox[oneKey], ['time'], ['desc'])
      }
    }
    for (let oneKey in this.outbox) {
      if (_.isArray(this.outbox[oneKey])) {
        this.outbox[oneKey] =  _.sortBy(this.outbox[oneKey], ['time'], ['desc'])
      }
    }

    let writeThisToDisk = {
      phase: this.round.phase,
      coin: this.round.coin,
      ephemeralKeypair: this.round.ephemeralKeypair,
      shuffled: this.round.shuffled,
      change: this.round.change,
      players: this.round.players,
      inbox: this.inbox,
      outbox: this.outbox
    };

    let data = JSON.stringify(writeThisToDisk, null, 2);  
    require('fs').writeFileSync('_failedShuffle.js', 'module.exports = '+data+';'); 
    process.exit(0);
  }

}

module.exports = CommChannel;