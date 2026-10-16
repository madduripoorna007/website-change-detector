const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config');

const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

const checkQueue = new Queue('checks', {
  connection,
  defaultJobOptions: {
    attempts: 3,                                   // retries
    backoff: { type: 'exponential', delay: 30000 },
    removeOnComplete: true,                         // must be removed so the same jobId can be queued again
    removeOnFail: true,
  },
});
const systemQueue = new Queue('system', { connection });

// jobId = target id: if a check for this target is already waiting, it is not queued twice.
async function enqueueCheck(targetId, { delay = 0, manual = false } = {}) {
  return checkQueue.add('check', { targetId: String(targetId), manual }, { jobId: `t-${targetId}`, delay });
}

module.exports = { connection, checkQueue, systemQueue, enqueueCheck };
