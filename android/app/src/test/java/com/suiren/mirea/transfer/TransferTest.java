package com.suiren.mirea.transfer;
import android.content.Context;import android.app.Notification;
import com.suiren.mirea.playback.PlaybackApi;
import org.json.*;import org.junit.*;import org.junit.runner.RunWith;import org.robolectric.*;import org.robolectric.annotation.Config;import org.robolectric.util.ReflectionHelpers;
import java.io.*;import java.nio.file.*;import java.util.*;import javax.crypto.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class TransferTest {
 private final Context context=RuntimeEnvironment.getApplication();
 private PlaybackApi api()throws Exception{return new PlaybackApi("https://mirea.example.test","a".repeat(43),UUID.randomUUID().toString());}
 private JSONObject manifest(String kind,int files)throws Exception{
  JSONArray parts=new JSONArray();for(int n=0;n<files;n++)parts.put(new JSONObject().put("index",n).put("number",n+1).put("size",20).put("chunks",1).put("mime",kind.equals("image-book")?"image/png":kind.equals("audio")?"audio/mp4":"application/pdf"));
  return new JSONObject().put("version",1).put("algorithm","AES-256-GCM").put("chunkSize",1048576).put("id",UUID.randomUUID().toString()).put("assetId",UUID.randomUUID().toString()).put("title","Encrypted fixture").put("kind",kind).put("pageCount",kind.equals("image-book")?files:1).put("files",parts);
 }
 @Test public void manifestBoundsSupportAllBookPagesButRejectPlaintextAndBadParts()throws Exception{
  JSONObject m=manifest("image-book",500);DownloadManifest.validate(m);assertEquals(10000,DownloadManifest.total(m));
  m.put("algorithm","plaintext");assertThrows(Exception.class,()->DownloadManifest.validate(m));m.put("algorithm","AES-256-GCM");m.getJSONArray("files").getJSONObject(0).put("chunks",99);assertThrows(Exception.class,()->DownloadManifest.validate(m));
  assertThrows(Exception.class,()->new TransferCache(context).folder("../bad",UUID.randomUUID().toString()));
 }
 @Test public void tenGiBMediaMatchesServerLimitsWithoutAllocatingItsContent()throws Exception{
  JSONObject m=manifest("audio",1),file=m.getJSONArray("files").getJSONObject(0);long size=10L*1024*1024*1024;file.put("size",size).put("chunks",(size+1048575)/1048576);DownloadManifest.validate(m);com.suiren.mirea.playback.PlaybackSource.validateManifest(m);assertEquals(size,DownloadManifest.total(m));
  size=com.suiren.mirea.playback.PlaybackLimits.MAX_ASSET_BYTES+1;file.put("size",size).put("chunks",(size+1048575)/1048576);assertThrows(Exception.class,()->DownloadManifest.validate(m));assertThrows(Exception.class,()->com.suiren.mirea.playback.PlaybackSource.validateManifest(m));
 }
 @Test public void cachePersistsOnlyVerifiedCiphertextIsolatesAccountsAndChecksEveryPage()throws Exception{
  PlaybackApi api=api();TransferCache cache=new TransferCache(context);JSONObject m=manifest("image-book",2);String id=m.getString("id");cache.begin(api.partition,m);
  byte[] cipher=new byte[48];new Random(12).nextBytes(cipher);String hash=TransferCache.hash(cipher);
  cache.put(api.partition,id,0,0,cipher,hash);assertThrows(Exception.class,()->cache.complete(api.partition,id));
  assertThrows(Exception.class,()->cache.put(api.partition,id,1,0,cipher,"0".repeat(64)));cache.put(api.partition,id,1,0,cipher,hash);cache.complete(api.partition,id);
  assertEquals(1,cache.completed(api.partition).length());assertEquals(0,cache.completed("b".repeat(64)).length());assertArrayEquals(cipher,cache.get(api.partition,id,0,0));
  Files.write(new File(cache.folder(api.partition,id),"0-0.chunk").toPath(),new byte[48]);assertNull(cache.get(api.partition,id,0,0));cache.remove(api.partition,id);assertEquals(0,cache.completed(api.partition).length());api.close();
 }
 @Test public void exportedLeaseIsWrappedAccountBoundAndNeverExtendsSevenDays()throws Exception{
  PlaybackApi api=api();KeyGenerator generator=KeyGenerator.getInstance("AES");generator.init(256);SecretKey key=generator.generateKey();TransferLease leases=new TransferLease(context,()->key);JSONObject m=manifest("image-book",500);
  long now=System.currentTimeMillis();JSONObject grant=new JSONObject().put("manifest",m).put("userId",api.userId).put("serverTime",now).put("expiresAt",now+7L*86400000).put("key",Base64.getEncoder().encodeToString(new byte[32]));
  leases.save(api,grant);String disk=context.getSharedPreferences("mirea-transfer-leases-v1",0).getAll().toString();assertFalse(disk.contains("Encrypted fixture"));assertFalse(disk.contains(grant.getString("key")));
  JSONObject restored=leases.load(api,m.getString("id"));assertTrue(restored.getLong("expiresAt")-restored.getLong("serverTime")<=7L*86400000);assertEquals(500,restored.getJSONObject("manifest").getJSONArray("files").length());
  assertThrows(Exception.class,()->leases.load(api(),m.getString("id")));leases.revoke(api.partition,m.getString("id"));assertThrows(Exception.class,()->leases.load(api,m.getString("id")));
  grant.put("expiresAt",now+7L*86400000+1);assertThrows(Exception.class,()->leases.save(api,grant));api.close();
 }
 @Test public void timedMediaPromotionSharesVerifiedCiphertextAndTransferAcknowledgementKeepsPlayback()throws Exception{
  try(PlaybackApi api=api()){
   TransferCache cache=new TransferCache(context);com.suiren.mirea.playback.PlaybackCache player=new com.suiren.mirea.playback.PlaybackCache(context);JSONObject m=manifest("audio",1);String id=m.getString("id");byte[] cipher=new byte[48];new Random(1).nextBytes(cipher);cache.begin(api.partition,m);cache.put(api.partition,id,0,0,cipher,TransferCache.hash(cipher));cache.complete(api.partition,id);
   player.promote(api.partition,m,cache.folder(api.partition,id));assertTrue(player.ready(api.partition,m));File source=new File(cache.folder(api.partition,id),"0-0.chunk"),promoted=new File(player.folder(api.partition,id),"0.chunk");assertTrue(Files.isSameFile(source.toPath(),promoted.toPath()));
   cache.remove(api.partition,id);assertArrayEquals(cipher,Files.readAllBytes(promoted.toPath()));assertTrue(player.ready(api.partition,m));player.remove(api.partition,id);assertFalse(promoted.exists());
  }
 }
 @Test public void promotionRejectsIntegrityFailuresAndForeignSourcesAndNeverPublishesAnIncompleteCache()throws Exception{
  try(PlaybackApi api=api()){
   TransferCache cache=new TransferCache(context);com.suiren.mirea.playback.PlaybackCache player=new com.suiren.mirea.playback.PlaybackCache(context);JSONObject m=manifest("audio",1);String id=m.getString("id");byte[] cipher=new byte[48];cache.begin(api.partition,m);cache.put(api.partition,id,0,0,cipher,TransferCache.hash(cipher));
   assertThrows(Exception.class,()->player.promote(api.partition,m,context.getFilesDir()));
   assertThrows(java.io.InterruptedIOException.class,()->player.promote(api.partition,m,cache.folder(api.partition,id),()->{throw new java.io.InterruptedIOException("cancelled");}));assertFalse(player.ready(api.partition,m));assertArrayEquals(cipher,cache.get(api.partition,id,0,0));
   Files.write(new File(cache.folder(api.partition,id),"0-0.sha256").toPath(),"0".repeat(64).getBytes(java.nio.charset.StandardCharsets.US_ASCII));assertThrows(IOException.class,()->player.promote(api.partition,m,cache.folder(api.partition,id)));assertFalse(player.ready(api.partition,m));
   cache.put(api.partition,id,0,0,cipher,TransferCache.hash(cipher));player.promote(api.partition,m,cache.folder(api.partition,id));Files.delete(new File(player.folder(api.partition,id),"0.chunk").toPath());assertFalse(player.ready(api.partition,m));assertFalse(player.begin(api.partition,m));
   cache.remove(api.partition,id);player.remove(api.partition,id);
  }
 }
 @Test public void rollbackAndMonotonicTimeExpireWithoutServerExtension()throws Exception{
  JSONObject r=new JSONObject().put("wall",10000).put("lastWall",12000).put("elapsed",100).put("lastElapsed",200).put("grant",new JSONObject().put("serverTime",500).put("expiresAt",10500));
  assertEquals(7000,TransferLease.remaining(r,13000,200));assertThrows(Exception.class,()->TransferLease.remaining(r,10000,200));assertTrue(TransferLease.remaining(r,13000,11100)<=0);
 }
 @Test public void snapshotsAndCancellationDoNotExposeCredentialsOrSelectedUris()throws Exception{
  PlaybackApi api=api();TransferEngine.Job job=new TransferEngine.Job("upload",api,new JSONObject().put("title","Fixture").put("uri","content://private/file"));String id=TransferService.offer(job);
  try{String data=TransferService.status(api.partition).toString();assertFalse(data.contains("a".repeat(43)));assertFalse(data.contains("content://"));assertTrue(data.contains("queued"));TransferService.cancel(id,api.partition);assertTrue(job.cancelled);assertTrue(api.closed);assertThrows(IOException.class,job::check);}finally{TransferService.discard(id);}
 }
 @Test public void notificationContainsPercentAndPrivateVisibilityWithoutStartingNetwork()throws Exception{
  PlaybackApi api=api();TransferEngine.Job job=new TransferEngine.Job("download",api,new JSONObject().put("title","Fixture"));String id=TransferService.offer(job);job.state="running";job.total=100;job.received=42;
  org.robolectric.android.controller.ServiceController<TransferService> controller=Robolectric.buildService(TransferService.class).create();
  try{Notification n=ReflectionHelpers.callInstanceMethod(controller.get(),"notice");assertTrue(n.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("42%"));assertEquals(Notification.VISIBILITY_PRIVATE,n.visibility);assertEquals(42,n.extras.getInt(Notification.EXTRA_PROGRESS));}
  finally{TransferService.discard(id);controller.destroy();}
 }
 @Test public void inputChunksAreBoundedAndDetectTruncatedSelections()throws Exception{
  assertArrayEquals(new byte[]{1,2,3},TransferEngine.readPart(new ByteArrayInputStream(new byte[]{1,2,3}),3));assertThrows(EOFException.class,()->TransferEngine.readPart(new ByteArrayInputStream(new byte[]{1,2}),3));
 }
 @Test public void wakeLockCoversQueuedRetryingAndStoppingWorkersButNotServerProcessing()throws Exception{
  TransferEngine.Job job=new TransferEngine.Job("upload",api(),new JSONObject());List<TransferEngine.Job> jobs=Collections.singletonList(job);
  try{
   assertTrue(TransferService.needsWakeLock(jobs,0,100));job.state="running";assertTrue(TransferService.needsWakeLock(jobs,0,100));
   job.state="processing";assertFalse(TransferService.needsWakeLock(jobs,0,100));assertTrue(TransferService.needsWakeLock(jobs,200,100));
   job.executing=true;assertTrue(TransferService.needsWakeLock(jobs,0,100));job.cancel();assertTrue(TransferService.needsWakeLock(jobs,0,100));
   job.executing=false;assertFalse(TransferService.needsWakeLock(jobs,0,100));
  }finally{job.cancel();}
 }
 @Test public void idleServerProcessingReleasesWakeLockAndNextTransferAcquiresItAgain()throws Exception{
  TransferEngine.Job job=new TransferEngine.Job("upload",api(),new JSONObject());String id=TransferService.offer(job);
  org.robolectric.android.controller.ServiceController<TransferService> controller=Robolectric.buildService(TransferService.class);TransferService service=controller.get();
  try{
   ReflectionHelpers.callInstanceMethod(service,"updateWakeLock");android.os.PowerManager.WakeLock wake=ReflectionHelpers.getField(service,"wake");assertTrue(wake.isHeld());
   job.state="processing";ReflectionHelpers.callInstanceMethod(service,"updateWakeLock");assertFalse(wake.isHeld());
   job.state="queued";ReflectionHelpers.callInstanceMethod(service,"updateWakeLock");assertTrue(wake.isHeld());
   job.cancel();ReflectionHelpers.callInstanceMethod(service,"updateWakeLock");assertFalse(wake.isHeld());
  }finally{TransferService.discard(id);service.onDestroy();}
 }
 @Test public void manualDispatchAddsOneSelectedUploadWithoutReplacingNormalTransfersAndIsolatesAccounts()throws Exception{
  PlaybackApi account=api(),other=api();List<TransferEngine.Job> jobs=new ArrayList<>();
  try{
   for(int n=0;n<6;n++){TransferEngine.Job job=new TransferEngine.Job("upload",account,new JSONObject().put("clientTransferId","q"+n));if(n<3){job.executing=true;job.state="running";}jobs.add(job);}
   TransferEngine.Job foreign=new TransferEngine.Job("upload",other,new JSONObject().put("clientTransferId","q5"));jobs.add(foreign);
   assertTrue(TransferService.dispatchCandidates(jobs).isEmpty());
   TransferService.applyManualStart(jobs,account.partition,"q5");
   assertEquals(Collections.singletonList(jobs.get(5)),TransferService.dispatchCandidates(jobs));
   assertFalse(foreign.manual);assertFalse(jobs.get(3).manual);
   jobs.get(5).executing=true;jobs.get(5).state="running";
   assertTrue(TransferService.dispatchCandidates(jobs).isEmpty());
   jobs.get(5).executing=false;jobs.get(5).state="complete";
   TransferService.applyManualStart(jobs,account.partition,"q0");
   assertEquals(Collections.singletonList(jobs.get(3)),TransferService.dispatchCandidates(jobs));
   jobs.get(3).cancelled=true;
   assertEquals(Collections.singletonList(jobs.get(4)),TransferService.dispatchCandidates(jobs));
  }finally{account.close();other.close();}
 }
 @Test public void parallelUploadBuffersFitSmallHeapsAndRespectServerBounds(){
  int chunk=8*1024*1024;
  assertEquals(4,TransferEngine.parallelParts(chunk,4,256L*1024*1024));
  assertEquals(2,TransferEngine.parallelParts(chunk,4,128L*1024*1024));
  assertEquals(1,TransferEngine.parallelParts(chunk,4,64L*1024*1024));
  assertEquals(2,TransferEngine.parallelParts(chunk*2,4,256L*1024*1024));
  assertEquals(1,TransferEngine.parallelParts(chunk,1,512L*1024*1024));
  assertEquals(1,TransferEngine.parallelParts(chunk,0,512L*1024*1024));
 }
 @Test public void clearDownloadsWaitsForWritersPurgesCompletedImportsAndKeepsOtherAccountsAndUploads()throws Exception{
  PlaybackApi account=api(),foreign=api();TransferCache cache=new TransferCache(context);JSONObject own=manifest("audio",1),other=manifest("audio",1);byte[] bytes=new byte[48];
  for(Object[] row:new Object[][]{{account,own},{foreign,other}}){PlaybackApi a=(PlaybackApi)row[0];JSONObject m=(JSONObject)row[1];cache.begin(a.partition,m);cache.put(a.partition,m.getString("id"),0,0,bytes,TransferCache.hash(bytes));cache.complete(a.partition,m.getString("id"));}
  TransferEngine.Job job=new TransferEngine.Job("download",account,new JSONObject()),upload=new TransferEngine.Job("upload",new PlaybackApi(account.origin,"a".repeat(43),account.userId),new JSONObject());TransferService.offer(job);TransferService.offer(upload);job.executing=true;
  Thread writer=new Thread(()->{try{while(!job.cancelled)Thread.sleep(5);Thread.sleep(40);}catch(InterruptedException e){Thread.currentThread().interrupt();}finally{job.executing=false;}});writer.start();
  try{TransferService.clearDownloads(account.partition,()->{assertFalse(job.executing);assertTrue(job.cancelled);assertFalse(upload.cancelled);assertThrows(IllegalStateException.class,()->TransferService.offer(new TransferEngine.Job("download",account,new JSONObject())));new TransferLease(context).clear(account.partition);cache.clear(account.partition);});
   assertEquals(0,cache.completed(account.partition).length());assertEquals(1,cache.completed(foreign.partition).length());assertEquals(1,TransferService.status(account.partition).length());assertThrows(IOException.class,job::check);
  }finally{writer.join(1000);TransferService.discard(job.id);TransferService.discard(upload.id);cache.clear(foreign.partition);account.close();foreign.close();}
 }
}
