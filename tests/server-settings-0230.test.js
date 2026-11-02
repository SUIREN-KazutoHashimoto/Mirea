import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createProcessingSettings} from '../server/processing-settings.js';
import {createOperationalSettings} from '../server/operational-settings.js';
test('environment overrides survive saved settings and the stored value returns when the override is removed',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const initial=createProcessingSettings(db,{});initial.update({maxConcurrentJobs:4,maxConcurrentUploads:2});
  const pinned=createProcessingSettings(db,{MAX_CONCURRENT_JOBS:'7'});assert.equal(pinned.value.maxConcurrentJobs,7);assert.equal(pinned.value.maxConcurrentUploads,2);assert.deepEqual(pinned.overrides.maxConcurrentJobs,{variable:'MAX_CONCURRENT_JOBS',value:7});
  pinned.update({maxConcurrentJobs:11,maxConcurrentUploads:3});assert.equal(pinned.value.maxConcurrentJobs,7);assert.equal(pinned.value.maxConcurrentUploads,3);assert.equal(createProcessingSettings(db,{}).value.maxConcurrentJobs,4);
  assert.throws(()=>createProcessingSettings(db,{MAX_CONCURRENT_JOBS:'17'}));assert.equal(createProcessingSettings(db,{}).value.maxConcurrentJobs,4);
 }finally{db.close();}
});
test('operational defaults need no environment; saved restart settings and explicit overrides are distinct',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');const settings=createOperationalSettings(db,{});assert.equal(settings.value.allowRegistration,true);assert.equal(settings.value.maxUploadBytes,2147483648);settings.update({maxUploadBytes:10*1024**3,allowRegistration:false});assert.equal(settings.value.allowRegistration,true);assert.equal(settings.metadata.restartRequired,true);const reloaded=createOperationalSettings(db,{ALLOW_REGISTRATION:'true'});assert.equal(reloaded.value.allowRegistration,true);assert.equal(reloaded.value.maxUploadBytes,10*1024**3);assert.deepEqual(reloaded.metadata.overrides.allowRegistration,{variable:'ALLOW_REGISTRATION',value:true});reloaded.update({allowRegistration:false});assert.equal(createOperationalSettings(db,{}).value.allowRegistration,false);assert.throws(()=>settings.update({uploadChunkBytes:1}));assert.throws(()=>createOperationalSettings(db,{ALLOW_REGISTRATION:'maybe'}));}finally{db.close();}
});
