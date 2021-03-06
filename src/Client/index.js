const Events = require('events');

const {
  WaitingRoom, Endpoints: LauncherEndpoint, Communicator,
} = require('epicgames-client');

const ENDPOINT = require('../../resources/Endpoint');

const Http = require('../Http');
const Item = require('../Inventory/Item');
const Inventory = require('../Inventory');

const SaveTheWorldSubGame = require('../SubGames/SaveTheWorld');
const BattleRoyaleSubGame = require('../SubGames/BattleRoyale');
const CreativeSubGame = require('../SubGames/Creative');

const ESubGame = require('../../enums/SubGame');

const FORTNITE_AUTHORIZATION = 'ZWM2ODRiOGM2ODdmNDc5ZmFkZWEzY2IyYWQ4M2Y1YzY6ZTFmMzFjMjExZjI4NDEzMTg2MjYyZDM3YTEzZmM4NGQ=';

class Client extends Events {

  constructor(launcher, config) {
    super(config);
    
    this.appName = 'Fortnite';
    this.libraryName = 'epicgames-fortnite-client';
        
    this.launcher = launcher;

    this.config = {
            
      useWaitingRoom: this.launcher.config.useWaitingRoom,
      useCommunicator: this.launcher.config.useCommunicator,
      http: this.launcher.config.http,

      ...config,

    };

    this.version = '4.22.0-5046157+++Fortnite+Release-7.40'; // "Engine Version:" in FortniteGame.log
    this.buildId = 4774386; // "Net CL:" in FortniteGame.log
        
    this.http = new Http(this.config.http);
    this.http.setHeader('Accept-Language', this.launcher.http.getHeader('Accept-Language'));

    this.basicData = null;
    this.storeCatalog = null;
    this.inventory = new Inventory(this, []);

    this.auth = null;

    this.communicator = null;
    this.profiles = {};

  }

  setLanguage(language) {
    this.http.setHeader('Accept-Language', language);
  }

  async init() {

    try {
            
      let wait = false;
      if (this.config.useWaitingRoom) {
        try {
          const waitingRoom = new WaitingRoom(this, ENDPOINT.WAITING_ROOM);
          wait = await waitingRoom.needWait();
        } catch (error) {
          this.debug.print(new Error(`WaitingRoom error: ${error}`));
          return false;
        }
      }
    
      if (wait) {
                    
        this.launcher.debug.print(`Problems with servers, need wait ${wait.expectedWait} seconds.`);
        const sto = setTimeout(() => {
          clearTimeout(sto);
          return this.init();
        }, wait.expectedWait * 1000);
    
      } else {

        const { data } = await this.http.sendGet(ENDPOINT.BASIC_DATA);
                
        if (data) {
                    
          this.basicData = data;

          const login = await this.login();
        
          await this.updateProfile('common_public');
          await this.updateProfile('common_core');

          this.inventory.addItems(Object.keys(this.profiles.common_core.items).map(
            id => new Item(this, {
              ...this.profiles.common_core.items[id],
              id,
            }),
          ));
          
          if (this.config.useCommunicator) {
            this.communicator = new Communicator(this);
            await this.communicator.connect(this.auth.accessToken);
          }

          this.launcher.on('access_token_refreshed', async () => {

            await this.login(true);

            if (this.communicator) {
              await this.communicator.disconnect();
              await this.communicator.connect(this.auth.accessToken);
            }

          });

          return login;

        }

      }

    } catch (err) {

      if (typeof err === 'object') this.launcher.debug.print(err);
      else this.launcher.debug.print(new Error(err));

    }

    return false;
  }
  
  async login(isRefresh) {

    try {

      this.launcher.debug.print(`Fortnite: ${isRefresh ? 'Exchanging refreshed access token...' : 'Exchanging access token...'}`);

      const { code } = await this.launcher.account.auth.exchange();

      if (code) {

        const { data } = await this.launcher.http.sendPost(LauncherEndpoint.OAUTH_TOKEN, `basic ${FORTNITE_AUTHORIZATION}`, {
          grant_type: 'exchange_code',
          exchange_code: code,
          includePerms: false,
          token_type: 'eg1',
        });

        this.auth = {
          accessToken: data.access_token,
          expiresIn: data.expires_in,
          expiresAt: new Date(data.expires_at),
          tokenType: data.token_type,
          refreshToken: data.refresh_token,
          refreshExpires: data.refresh_expires,
          refreshExpiresAt: new Date(data.refresh_expires_at),
          accountId: data.account_id,
          clientId: data.client_id,
          internalClient: data.internal_client,
          clientService: data.client_service,
          app: data.pp,
          inAppId: data.in_app_id,
          deviceId: data.device_id,
        };

        this.launcher.debug.print(`Fortnite: ${isRefresh ? 'Refreshed access token exchanged!' : 'Access token exchanged!'}`);

        if (!isRefresh) {
          
          await this.http.send(
            'DELETE',
            'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/sessions/kill?killType=OTHERS_ACCOUNT_CLIENT_SERVICE',
            `${this.auth.tokenType} ${this.auth.accessToken}`,
          );
          
        }

        await this.refreshStoreCatalog();

        return true;

      }

    } catch (err) {

      throw new Error(err);

    }

    return false;
  }

  async requestMCP(action, profileId, payload, rvn) {

    const { data } = await this.http.send(
      'POST',
      `${ENDPOINT.MCP_PROFILE}/${this.launcher.account.id}/client/${action}?profileId=${profileId}&rvn=${rvn || -1}&leanResponse=true`,
      `${this.auth.tokenType} ${this.auth.accessToken}`,
      payload || {},
    );

    return data;
  }

  async updateProfile(profileId, payload, rvn) {

    const data = await this.requestMCP('QueryProfile', profileId, payload, rvn);
    const profileChange = data.profileChanges[0];

    switch (profileChange.changeType) {
      
      case 'fullProfileUpdate':
        this.profiles[data.profileId] = profileChange.profile;
        break;

      default:
        this.launcher.debug(`Unknown profile change type: ${profileChange.changeType}`);
        break;

    }
    
  }

  async runSubGame(subGame) {
    
    let game;

    switch (subGame) {

      case ESubGame.SaveTheWorld:
        game = new SaveTheWorldSubGame(this);
        break;

      case ESubGame.BattleRoyale:
        game = new BattleRoyaleSubGame(this);
        break;

      case ESubGame.Creative:
        game = new CreativeSubGame(this);
        break;

      default:
        throw new Error('Unknown subgame!');
      
    }

    await game.init();

    return game;
  }
  
  async refreshBasicData() {

    try {

      const { data } = await this.http.sendGet(ENDPOINT.BASIC_DATA);
                
      if (data) {
        
        this.basicData = data;

        return this.basicData;

      }

    } catch (err) {

      this.launcher.debug.print(err);

    }

    return false;
  }
  
  async refreshStoreCatalog() {

    try {
            
      const { data } = await this.http.sendGet(
        ENDPOINT.STOREFRONT_CATALOG,
        `${this.auth.tokenType} ${this.auth.accessToken}`,
      );

      this.storeCatalog = data;

    } catch (err) {

      this.launcher.debug.print(err);

    }

  }

  get vbucks() {
    
    let sum = 0;
    
    this.inventory.findItemsByClass('Currency').forEach((currency) => {

      switch (currency.templateId) {
        
        case 'Currency:MtxComplimentary':
          sum += currency.quantity;
          break;
        
        case 'Currency:MtxGiveaway':
          sum += currency.quantity;
          break;
        
        default:
          this.launcher.debug.print(`Unknown currency with template '${currency.templateId}'`);
          break;

      }

    });

    return sum;
  }

  get giftsHistory() {
    return this.profiles.common_core.stats.attributes.gift_history.gifts.map(gift => ({
      offerId: gift.offerId,
      toAccountId: gift.toAccountId,
      time: new Date(gift.date),
    }));
  }

  get countOfSentGifts() {
    return this.profiles.common_core.stats.attributes.gift_history.num_sent;
  }

  get countOfReceivedGifts() {
    return this.profiles.common_core.stats.attributes.gift_history.num_received;
  }

  get canSendGifts() {
    return this.profiles.common_core.stats.attributes.allowed_to_send_gifts;
  }

  get canReceiveGifts() {
    return this.profiles.common_core.stats.attributes.allowed_to_receive_gifts;
  }

  get usedCreatorTag() {
    if (!this.profiles.common_core.stats.attributes.mtx_affiliate) return false;
    return {
      name: this.profiles.common_core.stats.attributes.mtx_affiliate,
      lastModified: this.profiles.common_core.stats.attributes.mtx_affiliate_set_time,
    };
  }

  get countUsedRefunds() {
    return this.profiles.common_core.stats.attributes.mtx_purchase_history.refundsUsed;
  }

  get countPossibleRefunds() {
    return this.profiles.common_core.stats.attributes.mtx_purchase_history.refundCredits;
  }

  get purchasesHistory() {
    return this.profiles.common_core.stats.attributes.mtx_purchase_history.purchases.map(purchase => ({
      purchaseId: purchase.purchaseId,
      offerId: purchase.offerId,
      purchaseDate: new Date(purchase.purchaseDate),
      refundDate: purchase.refundDate ? new Date(purchase.refundDate) : null,
      isRefunded: !!purchase.refundDate,
      fulfillments: purchase.fulfillments,
      paid: purchase.totalMtxPaid,
      lootResult: purchase.lootResult.map(item => new Item(this, {
        id: item.itemGuid,
        templateId: item.itemType,
        // itemProfile: item.itemProfile,
        quantity: item.quantity,
      })),
    }));
  }

}

module.exports = Client;
