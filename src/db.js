const mongoose = require('mongoose');
const config = require('./config');
const { Schema } = mongoose;

// One Target per normalized URL. Fetched once no matter how many users watch it.
const TargetSchema = new Schema({
  url: { type: String, required: true },          // URL as first given
  normalizedUrl: { type: String, required: true, unique: true },
  domain: { type: String, index: true },
  intervalMin: { type: Number, default: 60 },     // min interval across its watches
  nextCheckAt: { type: Date, default: Date.now, index: true },
  lastCheckedAt: Date,
  lastChangedAt: Date,
  status: { type: String, enum: ['pending', 'ok', 'error', 'blocked'], default: 'pending' },
  lastError: String,
  consecutiveFailures: { type: Number, default: 0 },
  backoffUntil: Date,
  etag: String,
  lastModified: String,
  lastHash: String,
  lastSnapshot: { type: Schema.Types.ObjectId, ref: 'Snapshot' },
  autoIgnore: { type: [String], default: [] },     // learned noisy leaf elements (DOM paths)
  autoMask: { type: [{ _id: false, selector: String, words: [Number] }], default: [] }, // learned noisy words inside a leaf
  learnedAt: Date,                                // when the two-load noise learning ran
  failingSince: Date,    // selectors learned as noisy (differ between two loads)
}, { timestamps: true });

// One Watch per user subscription. Holds the user's own regions, sensitivity and channels.
const WatchSchema = new Schema({
  owner: { type: String, required: true, index: true },
  name: { type: String, required: true },
  target: { type: Schema.Types.ObjectId, ref: 'Target', required: true, index: true },
  intervalMin: { type: Number, default: 60 },
  watchSelectors: { type: [String], default: [] },   // empty = whole page
  ignoreSelectors: { type: [String], default: [] },
  sensitivity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  keywords: { type: [String], default: [] },          // bonus: keyword-only alerts
  numberSelector: String,                              // bonus: number tracking
  channels: {
    email: String,
    discordWebhook: String,
    telegramChatId: String,
  },
  digest: { type: Boolean, default: false },
  visualAlerts: { type: Boolean, default: true },   // alert on screenshot-only changes (image/layout)
  active: { type: Boolean, default: true },
  lastEvaluatedAt: Date,
  lastHash: String,
  lastText: String,
  lastSnapshot: { type: Schema.Types.ObjectId, ref: 'Snapshot' },
  lastChangedAt: Date,
  downNotified: { type: Boolean, default: false },
  rssToken: { type: String, index: true },   // secret for the per-page RSS feed (feed readers can't log in)
}, { timestamps: true });

const SnapshotSchema = new Schema({
  target: { type: Schema.Types.ObjectId, ref: 'Target', required: true, index: true },
  contentHash: { type: String, required: true },
  text: String,           // cleaned full-page text
  html: String,           // cleaned HTML, used to apply each watch's selectors
  screenshot: String,     // file name in screenshotDir
  title: String,
  visualOnly: { type: Boolean, default: false }, // text identical, screenshot changed
  visualPct: Number,                              // % of page pixels changed vs the previous version
  boxes: { type: Schema.Types.Mixed, default: {} }, // selector -> on-page boxes, for per-region visual checks
}, { timestamps: true });

const CheckSchema = new Schema({
  target: { type: Schema.Types.ObjectId, ref: 'Target', index: true },
  result: { type: String, enum: ['ok', 'unchanged', 'changed', 'visual', 'error', 'blocked', 'skipped'] },
  httpStatus: Number,
  durationMs: Number,
  error: String,
}, { timestamps: true });
CheckSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

const NumberPointSchema = new Schema({
  watch: { type: Schema.Types.ObjectId, ref: 'Watch', index: true },
  value: Number,
}, { timestamps: true });

// One delivery attempt record per channel, so a failed Discord post never blocks the email,
// and each failed channel is retried on its own with backoff.
const DeliverySchema = new Schema({
  channel: { type: String, enum: ['email', 'discord', 'telegram'] },
  status: { type: String, enum: ['pending', 'sent', 'failed', 'dead'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  lastError: String,
  nextAttemptAt: Date,
  sentAt: Date,
}, { _id: false });

const AlertSchema = new Schema({
  watch: { type: Schema.Types.ObjectId, ref: 'Watch', index: true },
  kind: { type: String, enum: ['change', 'visual', 'down', 'recovered', 'digest'], default: 'change' },
  fromSnapshot: { type: Schema.Types.ObjectId, ref: 'Snapshot' },
  toSnapshot: { type: Schema.Types.ObjectId, ref: 'Snapshot' },
  summary: String,
  subject: String,          // exact message, stored so a retry resends the same words
  body: String,
  dedupeKey: { type: String, unique: true },   // watch + new content hash -> never alert twice
  sentAt: Date,             // set once every channel has been delivered
  pendingDigest: { type: Boolean, default: false },
  deliveries: { type: [DeliverySchema], default: [] },
}, { timestamps: true });
AlertSchema.index({ 'deliveries.status': 1, 'deliveries.nextAttemptAt': 1 });

// Accounts. Passwords are stored only as scrypt hashes; sessions only as SHA-256 of the cookie token.
const UserSchema = new Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
}, { timestamps: true });

const SessionSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  user: { type: String, required: true, index: true },   // username
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const User = mongoose.model('User', UserSchema);
const Session = mongoose.model('Session', SessionSchema);
const Target = mongoose.model('Target', TargetSchema);
const Watch = mongoose.model('Watch', WatchSchema);
const Snapshot = mongoose.model('Snapshot', SnapshotSchema);
const Check = mongoose.model('Check', CheckSchema);
const Alert = mongoose.model('Alert', AlertSchema);
const NumberPoint = mongoose.model('NumberPoint', NumberPointSchema);

async function connect() {
  await mongoose.connect(config.mongoUrl);
}

module.exports = { connect, User, Session, Target, Watch, Snapshot, Check, Alert, NumberPoint, mongoose };
