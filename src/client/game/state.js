import { is, Map } from 'immutable';
import { forEach, get, last, now } from 'lodash';
import Phaser, { Physics, Keyboard, Tilemap, Group } from 'phaser';
import { setState } from '../actions/game';
import { createLocalPlayer, createEntity, PLAYER } from '../factories/entity';
import { createLayer } from '../factories/layer';
import { findEntityIndexById } from '../helpers/game';
import RenderGroup from './groups/render';
import Text from './text';
import Entity from 'shared/game/entity';

const MUSIC_VOLUME = 0.01;
const TILE_LAYER = 'tilelayer';

// Require for dynamic loading of assets provided by the server.
const req = require.context('resources/assets', true, /\.(png|jpg|mp3|ogg|wav)$/);

class State extends Phaser.State {
  /**
   * Creates the actual game state.
   * @param store
   * @param socket
   * @param {Object} gameData
   * @param {Object} playerProps
   */
  constructor(store, socket, gameData, playerProps) {
    super();

    this._store = store;
    this._socket = socket;
    this._playerProps = playerProps;
    this._gameData = gameData;
    this._playerEntity = null;
    this._music = null;
    this._entities = [];
    this._root = null;
    this._groups = {};
    this._layers = {};
    this._texts = {};
    this._numPlayers = 0;
    this._ping = 0;
    this._pingSentAt = null;
    this._packetSequences = [];
    this._lastAction = null;

    this._socket.on('latency', this.handleLatency.bind(this));
    this._socket.on('set_state', this.handleSetState.bind(this));
  }

  /**
   * Loads game data such as spritesheets, images, audio and the map.
   */
  preload() {
    this.loadSpritesheets();
    this.loadImages();
    this.loadAudio();
    this.loadMap();
  }

  /**
   * Loads spritesheets from the game data.
   */
  loadSpritesheets() {
    const spritesheets = this.getGameData('assets.spritesheets');

    forEach(spritesheets, (data, key) => {
      if (data.url && data.frameWidth && data.frameHeight) {
        this.load.spritesheet(
          key,
          req(`./${data.url}`),
          data.frameWidth,
          data.frameHeight,
          data.numFrames || -1,
          data.margin || 0,
          data.spacing || 0
        );
      } else {
        console.warn(`Failed to load sprite ${key}.`);
      }
    });
  }

  /**
   * Loads images assets from the game data.
   */
  loadImages() {
    const images = this.getGameData('assets.images');

    forEach(images, (data, key) => {
      if (data.url) {
        this.load.image(key, req(`./${data.url}`));
      } else {
        console.warn(`Failed to load image ${key}.`);
      }
    });
  }

  /**
   * Loads audio assets from the game data.
   */
  loadAudio() {
    const audio = this.getGameData('assets.audio');

    forEach(audio, (data, key) => {
      const files = [];

      forEach(data.files, url => {
        files.push(req(`./${url}`));
      });

      this.load.audio(key, files);
    });
  }

  /**
   * Loads the tilemap from the game data.
   */
  loadMap() {
    const mapData = this.getGameData('map');
    this.load.tilemap(mapData.key, null, mapData.data, Tilemap.TILED_JSON);
  }

  /**
   * Called when the game is created to set up the initial state of the game.
   */
  create() {
    this.physics.startSystem(Physics.ARCADE);

    // Note: the order of these are IMPORTANT as it will determine the order that objects are rendered in.
    this.createMusic();
    this.createMap();
    this.createGroups();
    this.createPlayer();
    this.createUserInterface();
  }

  /**
   * Creates the background music for the game.
   */
  createMusic() {
    const music = this.getGameData('map.music');

    this._music = this.add.audio(music, MUSIC_VOLUME, true/* loop */);
    // this._music.mute = true; // for development purposes
    this._music.play();

    const muteKey = this.input.keyboard.addKey(Keyboard.M);
    muteKey.onDown.add(this.handleMutePressed.bind(this));
  }

  /**
   * Creates the map for the game.
   */
  createMap() {
    const mapData = this.getGameData('map');
    const map = this.add.tilemap(mapData.key, mapData.image);

    map.addTilesetImage(mapData.key, mapData.image);

    forEach(mapData.layers, props => {
      if (props.type === TILE_LAYER) {
        this.addLayer(props.name, createLayer(map, props));
      }
    });
  }

  /**
   * Creates the groups for the game.
   */
  createGroups() {
    this._root = new RenderGroup(this);
    this.addGroup('root', this._root);
    this.addGroup('knights', this.add.group(this._root, 'knights', false, true));
    this.addGroup('flags', this.add.group(this._root, 'flags', false, true));
    this.addGroup('attacks', this.add.group(this._root, 'attacks', false, true));
    this.addGroup('ui', this.add.group());
  }

  /**
   * Creates the local player entity.
   */
  createPlayer() {
    this._playerEntity = createLocalPlayer(this, this._playerProps);
    this.addEntity(this._playerEntity);
  }

  /**
   * Creates the user interface elements (texts, etc.)
   */
  createUserInterface() {
    const textData = this.getGameData('ui.texts');
    const config = this.getGameData('config');
    const uiGroup = this.getGroup('ui');

    const style = { font: '14px Courier', stroke: '#000', strokeThickness: 5, fill: '#fff' };

    forEach(textData, (data, key) => {
      let x = data.x >= 0 ? data.x : config.gameWidth + data.x;
      let y = data.y >= 0 ? data.y : config.gameHeight + data.y;
      let text = this.add.text(x, y, data.text, style, uiGroup);
      text.fixedToCamera = true;
      if (data.x < 0) {
        text.anchor.set(1, 0);
      }
      this.addText(key, new Text(text, style, data.text));
    });
  }

  /**
   * Called when the mute button (M) is pressed.
   */
  handleMutePressed() {
    this._music.mute = !this._music.mute;
  }

  /**
   *
   * @param {Object} state
   * @param {number} sequence
   */
  handleSetState(state, sequence) {
    this._store.dispatch(setState(state));
    this._packetSequences.push(sequence);
  }

  /**
   * Called every time the server pings the client.
   * @param {number} timestamp
   */
  handleLatency(timestamp) {
    this._ping = now() - timestamp;
  }

  /**
   * Called when the game is updated.
   */
  update() {
    this.updateEntities();
    this.updateTexts();

    // Sort all the entities according to their y position so that those with a higher y position is rendered on top.
    this._root.sort('y', Group.SORT_ASCENDING);
  }

  /**
   * Updates the state for each entity in the game,
   * as well as creates new entities and destroys expired entities.
   */
  updateEntities() {
    const gameState = this.gameState;
    const updatedEntityIds = [];

    forEach(gameState.entities, props => {
      let entity = this.getEntity(props);

      if (entity) {
        entity.update(props, this.dispatch.bind(this));
      }

      updatedEntityIds.push(props.id);
    });

    this._entities = this._entities.filter(entity => {
      const found = updatedEntityIds.indexOf(entity.id) !== -1;

      if (!found) {
        if (entity.getProp('type') === PLAYER) {
          this._numPlayers--;
        }

        entity.destroy();
      }

      return found;
    });
  }

  /**
   * Adds an entity to the game's entity pool.
   * @param {Entity} entity
   */
  addEntity(entity) {
    if (!entity instanceof Entity) {
      throw new Error('Session entities must be instances of Entity.');
    }

    if (entity.getProp('type') === PLAYER) {
      this._numPlayers++;
    }

    this._entities.push(entity);
  }

  /**
   * Returns an entity from the game's entity pool (creating it if it doesn't exist).
   * @param {Object} props
   * @returns {Entity}
   */
  getEntity(props) {
    const index = findEntityIndexById(this._entities, props.id);

    if (index !== -1) {
      return this._entities[index];
    }

    const entity = createEntity(this, props);

    if (entity) {
      this.addEntity(entity);
    }

    return entity;
  }

  /**
   * Returns whether or not the 'ping' text should be updated.
   * @returns {boolean}
   */
  shouldUpdatePing() {
    const timeNow = now();
    this._socket.emit('latency', timeNow);
    const result = timeNow - this._pingSentAt > 100;
    this._pingSentAt = timeNow;
    return result;
  }

  /**
   * Returns whether or not the 'packet loss' text should be updated.
   * @returns {boolean}
   */
  shouldUpdatePacketLoss() {
    return last(this._packetSequences) % 100 === 0;
  }

  /**
   * Calculates the packet loss.
   * @returns {number}
   */
  calculatePacketLoss() {
    const packetsReceived = this._packetSequences.length;
    this._packetSequences.length = 0;
    const packetsLost = 100 - packetsReceived;
    return packetsLost > 0 ? packetsLost / packetsReceived : 0;
  }

  /**
   * Destroys a set of entities from the games entity pool.
   * @param {Array} ids
   */
  destroyEntities(ids) {
    this._entities = this._entities.filter(entity => {
      let isRemoved = ids.indexOf(entity.id) !== -1;

      if (isRemoved) {
        entity.destroy();

        if (entity.getProp('type') === 'player') {
          this._numPlayers--;
        }
      }

      return !isRemoved;
    });
  }

  /**
   * Returns data for this game.
   * @param {string} key
   * @returns {Object}
   */
  getGameData(key) {
    return get(this._gameData, key);
  }

  /**
   * Adds a layer to this game's layer pool.
   * @param {string} key
   * @param {Phaser.TilemapLayer} layer
   */
  addLayer(key, layer) {
    this._layers[key] = layer;
  }

  /**
   * Returns a layer from this game's layer pool.
   * @param {string} key
   * @returns {Phaser.TilemapLayer}
   */
  getLayer(key) {
    return this._layers[key];
  }

  /**
   * Adds a group to this game's group pool.
   * @param {string} key
   * @param {Phaser.Group} group
   */
  addGroup(key, group) {
    this._groups[key] = group;
  }

  /**
   * Returns a group from this game's group pool.
   * @param {string} key
   * @returns {Phaser.Group} group
   */
  getGroup(key) {
    return this._groups[key];
  }

  /**
   *
   * @param {string} key
   * @param {Phaser.Text} text
   */
  addText(key, text) {
    this._texts[key] = text;
  }

  /**
   *
   * @param {string} key
   * @param {Object} params
   * @param {Object} style
   */
  updateText(key, params, style) {
    const text = this._texts[key];

    if (!text) {
      return;
    }

    text.update(params, style);
  }

  /**
   *
   * @param key
   */
  hideText(key) {
    const text = this._texts[key];

    if (!text) {
      return;
    }

    text.hide();
  }

  /**
   * Dispatches an action to the store.
   * @param {Object} action
   */
  dispatch(action) {
    if (this.shouldDispatchAction(action)) {
      this._store.dispatch(action);
      this._lastAction = action;
    }
  }

  /**
   * Returns whether or not an action should be dispatched, i.e. has it changed.
   * This is necessary to ensure that the server is not flooded with duplicate actions.
   * @returns {boolean}
   */
  shouldDispatchAction(action) {
    return !this._lastAction || !is(Map(action), Map(this._lastAction));
  }

  /**
   * Returns the current state of this game.
   * @returns {Object}
   */
  get gameState() {
    return this._store.getState().game.toJS();
  }
}

export default State;