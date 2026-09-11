import 'dotenv/config'
import { Worker } from 'bullmq'
import { createRedisConnection, getRedis, closeRedis } from '../server/lib/redis'
import { getSettings } from '../server/lib/settings'
import { closeDb } from '../server/lib/db'
import { closeQueues, IMPORT_QUEUE, REFRESH_QUEUE, enqueueAccountRefresh } from '../server/lib/queues'
import { processImport, processRefresh } from './tasks'
import { schedulerTick, WORKER_HEARTBEAT_KEY } from './scheduler'
import { migrate } from '../server/lib/migrations'

async function main() {
  await migrate()
  const settings=await getSettings()
  const importer=new Worker(IMPORT_QUEUE,processImport,{connection:createRedisConnection(),concurrency:1})
  const refresher=new Worker(REFRESH_QUEUE,processRefresh,{connection:createRedisConnection(),concurrency:settings.refreshConcurrency})
  for(const worker of [importer,refresher])worker.on('error',()=>{console.error('Worker queue connection error')})
  refresher.on('completed',job=>{
    void getRedis().exists(`ccm:refresh:dirty:${job.data.accountId}`).then(dirty=>dirty?enqueueAccountRefresh(job.data.accountId,{reason:'request'}):undefined).catch(()=>{})
  })
  const timer=setInterval(()=>{void getSettings().then(s=>{refresher.concurrency=s.refreshConcurrency;return schedulerTick()}).catch(()=>{console.error('Worker scheduler check failed')})},10_000)
  timer.unref()
  const heartbeat=setInterval(()=>{void getRedis().set(WORKER_HEARTBEAT_KEY,new Date().toISOString(),'EX',45).catch(()=>{})},10_000)
  heartbeat.unref()
  await schedulerTick()
  let closing=false
  const stop=async()=>{
    if(closing)return;closing=true;clearInterval(timer);clearInterval(heartbeat)
    await Promise.all([importer.close(),refresher.close()]);await closeQueues();await closeRedis();await closeDb()
  }
  process.on('SIGTERM',()=>{void stop()});process.on('SIGINT',()=>{void stop()})
}
main().catch(async()=>{console.error('Worker startup failed; check database, Redis and configuration.');await closeRedis();await closeDb();process.exitCode=1})