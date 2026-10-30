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
}
