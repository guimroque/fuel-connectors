import {
  type AbiMap,
  Address,
  type Asset,
  type ConnectorMetadata,
  FuelConnector,
  FuelConnectorEventTypes,
  type JsonAbi,
  type Network,
  type SelectNetworkArguments,
  type TransactionRequestLike,
  type TransactionResponse,
  type Version,
} from 'fuels';

import {
  BakoProvider,
  TypeUser,
  Vault,
  encodeSignature,
  getTxIdEncoded,
} from 'bakosafe';
import { SocketClient } from './SocketClient';
import type {
  ConnectorConfig,
  Maybe,
  MaybeAsync,
  PredicateConfig,
  ProviderDictionary,
} from './types';

// Configuration constants
const BAKO_SERVER_URL = 'https://stg-api.bako.global';
const SELECTED_PREDICATE_KEY = 'fuel_selected_predicate_version';

// Local storage keys for session management
const STORAGE_KEYS = {
  AUTH_PREFIX: 'connector',
  DEFAULT_ACCOUNT: 'default',
  SESSION_ID: 'sessionId',
  ACCOUNT_VALIDATED: 'accountValidated',
  CURRENT_ACCOUNT: 'currentAccount',
} as const;

/**
 * Abstract base class for predicate-based wallet connectors.
 * Handles common logic for Bako Safe integration, session management,
 * and provides template methods for wallet-specific implementations.
 */
export abstract class PredicateConnector extends FuelConnector {
  // Connection state
  public connected = false;
  public installed = false;
  public external = true;
  public events = FuelConnectorEventTypes;

  // Protected properties for internal state management
  protected predicateAddress!: string;
  protected customPredicate: Maybe<PredicateConfig>;
  protected subscriptions: Array<() => void> = [];
  protected hasProviderSucceeded = true;

  // Socket client for real-time communication with Bako Safe
  protected socketClient: Maybe<SocketClient> = null;

  // Abstract properties that subclasses must implement
  public abstract name: string;
  public abstract metadata: ConnectorMetadata;

  constructor() {
    super();
    this.initializeSocketClient();
  }

  /**
   * Main connection method that orchestrates the connection flow.
   * Subclasses implement wallet-specific connection logic.
   */
  public async connect(): Promise<boolean> {
    // Step 1: Establish wallet connection (implemented by subclass)
    const walletConnectionSuccessful = await this._connect();
    if (!walletConnectionSuccessful) {
      return false;
    }

    // Step 2: Setup Bako Safe integration
    const { fuelProvider } = await this._get_providers();
    const evmAddress = this._get_current_evm_address();
    if (!evmAddress) {
      throw new Error('EVM address not found');
    }

    const fuelAddress = new Address(evmAddress).toB256();
    console.log('Connecting with account:', fuelAddress);

    // Step 3: Authenticate with Bako Safe
    const challengeCode = await BakoProvider.setup({
      provider: fuelProvider.url,
      address: fuelAddress,
      encoder: TypeUser.EVM,
      serverApi: BAKO_SERVER_URL,
    });

    const challengeSignature = await this._sign_message(challengeCode);
    const sessionId = this.getSessionId();

    const bakoProvider = await BakoProvider.authenticate(fuelProvider.url, {
      address: fuelAddress,
      challenge: challengeCode,
      encoder: TypeUser.EVM,
      token: challengeSignature,
      serverApi: BAKO_SERVER_URL,
    });

    await bakoProvider.connectDapp(sessionId);

    // Step 4: Get wallet instance and update state
    const wallet = await bakoProvider.wallet();

    this.emit(this.events.connection, true);
    this.emit(this.events.currentAccount, wallet.address);
    this.emit(this.events.accounts, wallet.address ? [wallet.address] : []);
    this.connected = true;

    localStorage.setItem(STORAGE_KEYS.CURRENT_ACCOUNT, wallet.address.toB256());

    return true;
  }

  /**
   * Sends a transaction through the predicate system.
   * Handles Bako Safe integration and signature requirements.
   */
  public async sendTransaction(
    address: string,
    transaction: TransactionRequestLike,
  ): Promise<TransactionResponse> {
    try {
      const { fuelProvider } = await this._get_providers();
      const evmAddress = this._get_current_evm_address();

      if (!evmAddress) {
        throw new Error('No connected accounts');
      }

      const fuelAddress = new Address(evmAddress).toB256();
      const bakoProvider = await BakoProvider.create(fuelProvider.url, {
        address: fuelAddress,
        token: `connector${this.getSessionId()}`,
        serverApi: BAKO_SERVER_URL,
      });

      const vault = await Vault.fromAddress(
        new Address(address).toB256(),
        bakoProvider,
      );

      const { tx, hashTxId } = await vault.BakoTransfer(transaction);

      // Encode message according to predicate version requirements
      const messageToSign = getTxIdEncoded(hashTxId, vault.version);
      const signature = await this._sign_message(messageToSign);
      const encodedSignature = encodeSignature(
        evmAddress,
        signature,
        vault.version,
      );

      await bakoProvider.signTransaction({
        hash: hashTxId,
        signature: encodedSignature,
      });

      const transactionResponse = await vault.send(tx);
      console.log('Transaction sent:', transactionResponse);

      await transactionResponse.waitForResult();

      return transactionResponse;
    } catch (error) {
      console.error('[CONNECTOR] Transaction error:', error);
      throw error;
    }
  }

  // ============================================================
  // Abstract methods to be implemented by subclasses
  // ============================================================

  /**
   * Signs a message using the connected wallet.
   * @param message - Message to be signed
   * @returns Promise with the signature
   */
  protected abstract _sign_message(message: string): Promise<string>;

  /**
   * Gets the configured providers (Fuel and EVM).
   * @returns Promise with the providers dictionary
   */
  protected abstract _get_providers(): Promise<ProviderDictionary>;

  /**
   * Gets the current EVM address from the connected wallet.
   * @returns EVM address or null if not connected
   */
  protected abstract _get_current_evm_address(): Maybe<string>;

  /**
   * Checks if there is an active connection, throws if not.
   */
  protected abstract _require_connection(): MaybeAsync<void>;

  /**
   * Configures the providers based on the connector configuration.
   * @param config - Connector configuration
   */
  protected abstract _config_providers(
    config: ConnectorConfig,
  ): MaybeAsync<void>;

  /**
   * Handles the wallet connection logic.
   * Called by connect() before executing any Bako Safe logic.
   */
  protected abstract _connect(): Promise<boolean>;

  /**
   * Handles the wallet disconnection logic.
   * Called by the disconnect() method.
   */
  protected abstract _disconnect(): Promise<boolean>;

  // ============================================================
  // Base methods implemented (can be overridden if needed)
  // ============================================================

  /**
   * Health check method to verify provider availability.
   */
  public async ping(): Promise<boolean> {
    try {
      await this._get_providers();
      this.hasProviderSucceeded = true;
      return true;
    } catch (_error) {
      this.hasProviderSucceeded = false;
      return false;
    }
  }

  /**
   * Returns connector version information.
   */
  public async version(): Promise<Version> {
    return { app: '0.0.0', network: '0.0.0' };
  }

  /**
   * Checks if the connector is currently connected.
   */
  public async isConnected(): Promise<boolean> {
    try {
      await this._require_connection();
      const accounts = await this.accounts();
      return accounts.length > 0;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Gets all available accounts.
   */
  public async accounts(): Promise<Array<string>> {
    const currentAccount = window.localStorage.getItem(
      STORAGE_KEYS.CURRENT_ACCOUNT,
    );
    return currentAccount ? [currentAccount] : [];
  }

  /**
   * Gets the currently active account.
   */
  public async currentAccount(): Promise<string | null> {
    if (!this.connected) {
      return null;
    }
    return window.localStorage.getItem(STORAGE_KEYS.CURRENT_ACCOUNT) ?? null;
  }

  /**
   * Disconnects the connector and cleans up resources.
   */
  public async disconnect(): Promise<boolean> {
    await this._disconnect();
    this.connected = false;

    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(SELECTED_PREDICATE_KEY);
        window.localStorage.removeItem(STORAGE_KEYS.CURRENT_ACCOUNT);
        window.localStorage.removeItem(STORAGE_KEYS.DEFAULT_ACCOUNT);
      }
    } catch (error) {
      console.error('Error clearing localStorage during disconnect:', error);
    }

    this.emit(this.events.connection, false);
    this.emit(this.events.currentAccount, null);
    this.emit(this.events.accounts, []);

    return true;
  }

  /**
   * Gets available networks.
   */
  public async networks(): Promise<Network[]> {
    return [await this.currentNetwork()];
  }

  /**
   * Gets the current network information.
   */
  public async currentNetwork(): Promise<Network> {
    const { fuelProvider } = await this._get_providers();
    return {
      url: fuelProvider.url,
      chainId: await fuelProvider.getChainId(),
    };
  }

  /**
   * Signs a message using the connected wallet.
   */
  public async signMessage(_address: string, message: string): Promise<string> {
    return await this._sign_message(message);
  }

  // ============================================================
  // Unimplemented methods (throw errors as expected)
  // ============================================================

  public async addAssets(_assets: Asset[]): Promise<boolean> {
    throw new Error('Method not implemented');
  }

  public async addAsset(_asset: Asset): Promise<boolean> {
    throw new Error('Method not implemented');
  }

  public async assets(): Promise<Array<Asset>> {
    throw new Error('Method not implemented');
  }

  public async addNetwork(_networkUrl: string): Promise<boolean> {
    throw new Error('Method not implemented');
  }

  public async selectNetwork(
    _network: SelectNetworkArguments,
  ): Promise<boolean> {
    throw new Error('Method not implemented');
  }

  public async addAbi(_abiMap: AbiMap): Promise<boolean> {
    throw new Error('Method not implemented');
  }

  public async getAbi(_contractId: string): Promise<JsonAbi> {
    throw new Error('Method not implemented');
  }

  public async hasAbi(_contractId: string): Promise<boolean> {
    throw new Error('Method not implemented');
  }

  // ============================================================
  // Private helper methods
  // ============================================================

  /**
   * Initializes the socket client for real-time communication.
   */
  private initializeSocketClient(): void {
    this.socketClient = SocketClient.create({
      sessionId: this.getSessionId(),
      events: this,
    });
  }

  /**
   * Generates or retrieves a session ID for the current session.
   */
  protected getSessionId(): string {
    let sessionId =
      window?.localStorage.getItem(STORAGE_KEYS.SESSION_ID) ?? null;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      window?.localStorage.setItem(STORAGE_KEYS.SESSION_ID, sessionId);
    }
    return sessionId;
  }

  /**
   * Emits a custom event through the socket client.
   */
  protected emitCustomEvent(event: string, data: unknown): void {
    if (!this.socketClient) {
      throw new Error('Socket client is not initialized');
    }
    this.socketClient.server.emit(event, data);
  }

  /**
   * Emits account change events.
   */
  protected async emitAccountChange(
    _address: string,
    connected = true,
  ): Promise<void> {
    this.emit(this.events.connection, connected);
    this.emit(this.events.currentAccount, this.currentAccount());
    this.emit(this.events.accounts, []);
  }

  /**
   * Subscribes to events.
   */
  protected subscribe(listener: () => void) {
    this.subscriptions.push(listener);
  }

  /**
   * Clears all active subscriptions.
   */
  public clearSubscriptions() {
    if (!this.subscriptions) {
      return;
    }
    this.subscriptions.forEach((listener) => listener());
    this.subscriptions = [];
  }
}
