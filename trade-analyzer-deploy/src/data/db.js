import mongoose from 'mongoose';
import crypto from 'crypto';

const stateSchema = new mongoose.Schema({
  stateId: { type: String, default: 'global_state', unique: true },
  activeTrades: { type: Array, default: [] },
  tradeHistory: { type: Array, default: [] },
  accountBalance: { type: Number, default: 5000.0 },
  dailyLosses: { type: Number, default: 0 },
  lastExecutedCandleTime: { type: Map, of: Number, default: {} },
  lastClosedTime: { type: Map, of: Number, default: {} },
  lastResetDate: { type: String, default: '' }
}, { minimize: false });

const StateModel = mongoose.model('TerminalState', stateSchema);

const inviteCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  usedBy: { type: Number, default: null },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
const InviteCode = mongoose.model('InviteCode', inviteCodeSchema);

const subscriberSchema = new mongoose.Schema({
  telegramUserId: { type: Number, required: true, unique: true },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  active: { type: Boolean, default: true },
  subscribedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null },
});
const Subscriber = mongoose.model('Subscriber', subscriberSchema);

export class DBManager {
  constructor() {
    this.isConnected = false;
    this.cachedState = null;
  }

  async connect(uri) {
    if (this.isConnected) return;
    try {
      console.log('[DBManager] Connecting to MongoDB Atlas...');
      await mongoose.connect(uri);
      this.isConnected = true;
      console.log('[DBManager] Connected securely to MongoDB Atlas.');
      // Initialize state if not exists
      await this.loadState();
    } catch (err) {
      console.error('[DBManager] Connection failed:', err);
      throw err;
    }
  }

  async loadState() {
    try {
      let state = await StateModel.findOne({ stateId: 'global_state' });
      if (!state) {
        console.log('[DBManager] Global state document not found. Creating new global state.');
        state = new StateModel({
          lastResetDate: new Date().toDateString()
        });
        await state.save();
      }
      this.cachedState = state;
      return {
        activeTrades: state.activeTrades || [],
        tradeHistory: state.tradeHistory || [],
        accountBalance: state.accountBalance ?? 5000.0,
        dailyLosses: state.dailyLosses ?? 0,
        lastExecutedCandleTime: Object.fromEntries(state.lastExecutedCandleTime || new Map()),
        lastClosedTime: Object.fromEntries(state.lastClosedTime || new Map()),
        lastResetDate: state.lastResetDate
      };
    } catch (err) {
      console.error('[DBManager] Error loading state:', err);
      return {
        activeTrades: [],
        tradeHistory: [],
        accountBalance: 5000.0,
        dailyLosses: 0,
        lastExecutedCandleTime: {},
        lastClosedTime: {},
        lastResetDate: new Date().toDateString()
      };
    }
  }

  async saveActiveTrades(activeTrades) {
    this._updateState({ activeTrades });
  }

  async saveTradeHistory(tradeHistory) {
    this._updateState({ tradeHistory });
  }

  async saveDailyLosses(dailyLosses, date) {
    const update = { dailyLosses };
    if (date) update.lastResetDate = date;
    this._updateState(update);
  }

  async saveAccountBalance(accountBalance) {
    this._updateState({ accountBalance });
  }

  async saveLastExecutedCandleTime(lastExecutedCandleTime) {
    this._updateState({ lastExecutedCandleTime });
  }

  async saveLastClosedTime(lastClosedTime) {
    this._updateState({ lastClosedTime });
  }

  /** @private */
  async _updateState(fields) {
    if (!this.isConnected) {
      console.warn('[DBManager] Not connected to database. Bypass saving.');
      return;
    }
    try {
      await StateModel.updateOne({ stateId: 'global_state' }, { $set: fields }, { upsert: true });
    } catch (err) {
      console.error('[DBManager] Error updating state fields:', fields, err);
    }
  }

  // ---- Invite Code System ----

  async generateInviteCodes(count) {
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      const doc = await InviteCode.findOneAndUpdate(
        { code },
        { code, createdAt: new Date() },
        { upsert: true, new: true }
      );
      if (doc && !doc.usedBy) codes.push(doc);
    }
    return codes;
  }

  async redeemCode(code, telegramUserId, username, firstName) {
    const invite = await InviteCode.findOne({ code: code.toUpperCase(), usedBy: null });
    if (!invite) return { ok: false, message: 'Kode tidak valid atau sudah digunakan.' };
    invite.usedBy = telegramUserId;
    invite.usedAt = new Date();
    invite.username = username || '';
    invite.firstName = firstName || '';
    await invite.save();
    await Subscriber.findOneAndUpdate(
      { telegramUserId },
      { telegramUserId, username: username || '', firstName: firstName || '', active: true, subscribedAt: new Date(), expiresAt: null },
      { upsert: true, new: true }
    );
    return { ok: true, message: 'Berhasil! Akses lifetime Anda sudah aktif.' };
  }

  async isSubscriber(telegramUserId) {
    if (!telegramUserId) return false;
    const sub = await Subscriber.findOne({ telegramUserId, active: true });
    return !!sub;
  }

  async listInviteCodes() {
    return InviteCode.find().sort({ createdAt: -1 });
  }

  async listSubscribers() {
    return Subscriber.find({ active: true }).sort({ subscribedAt: -1 });
  }
}

export default DBManager;
