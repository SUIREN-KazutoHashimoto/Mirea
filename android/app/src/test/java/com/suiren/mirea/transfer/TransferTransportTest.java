package com.suiren.mirea.transfer;
import android.content.Context;
import com.suiren.mirea.playback.PlaybackApi;
import org.json.*;import org.junit.*;import org.junit.runner.RunWith;import org.robolectric.*;import org.robolectric.annotation.Config;
import java.io.*;import java.net.*;import java.nio.charset.StandardCharsets;import java.util.*;import javax.crypto.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class TransferTransportTest {
 private static class Response extends HttpURLConnection {
  final byte[] bytes;final int status;final ByteArrayOutputStream request=new ByteArrayOutputStream();final Map<String,String> responseHeaders=new HashMap<>();
  Response(String path,String method,int status,byte[] bytes)throws Exception{super(new URL("https://mirea.example.test"+path));this.method=method;this.status=status;this.bytes=bytes;}
  @Override public void connect(){}@Override public void disconnect(){}@Override public boolean usingProxy(){return false;}
  @Override public int getResponseCode(){return status;}@Override public InputStream getInputStream(){return new ByteArrayInputStream(bytes);}@Override public OutputStream getOutputStream(){return request;}
  @Override public String getHeaderField(String name){return responseHeaders.get(name);}
 }
 private JSONObject manifest()throws Exception{
  JSONArray files=new JSONArray();for(int n=0;n<2;n++)files.put(new JSONObject().put("index",n).put("number",n+1).put("size",20).put("chunks",1).put("mime","image/png"));
  return new JSONObject().put("id",UUID.randomUUID().toString()).put("assetId",UUID.randomUUID().toString()).put("version",1).put("algorithm","AES-256-GCM").put("chunkSize",1048576).put("kind","image-book").put("pageCount",2).put("title","Transport fixture").put("files",files);
 }
 @Test public void backgroundDownloadRunsEveryPageAndExplicitJsonLeaseWithoutAnyActivityOrWebView()throws Exception{
  Context c=RuntimeEnvironment.getApplication();PlaybackApi api=new PlaybackApi("https://mirea.example.test","a".repeat(43),UUID.randomUUID().toString());JSONObject m=manifest();String id=m.getString("id"),asset=m.getString("assetId");
  KeyGenerator generator=KeyGenerator.getInstance("AES");generator.init(256);SecretKey key=generator.generateKey();TransferLease leases=new TransferLease(c,()->key);
  byte[] cipher=new byte[48];new Random(1).nextBytes(cipher);List<Response> requests=new ArrayList<>();long now=System.currentTimeMillis();
  JSONObject grant=new JSONObject().put("manifest",m).put("userId",api.userId).put("key",Base64.getEncoder().encodeToString(new byte[32])).put("serverTime",now).put("expiresAt",now+7L*86400000);
  TransferEngine.ConnectionFactory transport=(identity,path,method)->{
   try{
    Response response;
    if(path.equals("/api/v1/items/"+asset+"/download"))response=new Response(path,method,200,new JSONObject().put("manifest",m).toString().getBytes(StandardCharsets.UTF_8));
    else if(path.matches("/api/v1/downloads/"+id+"/files/[01]/parts/0")){response=new Response(path,method,200,cipher);response.responseHeaders.put("X-Chunk-SHA256",TransferCache.hash(cipher));}
    else if(path.equals("/api/v1/downloads/"+id+"/open"))response=new Response(path,method,200,grant.toString().getBytes(StandardCharsets.UTF_8));
    else response=new Response(path,method,404,new byte[0]);
    requests.add(response);return response;
   }catch(Exception error){throw new IOException(error);}
  };
  TransferEngine.Job job=new TransferEngine.Job("download",api,new JSONObject().put("assetId",asset).put("title","Transport fixture"));new TransferEngine(c,()->{},transport,leases).run(job);
  assertEquals("complete",job.state);assertEquals(40,job.received);assertEquals(2,requests.stream().filter(r->r.getURL().getPath().contains("/parts/")).count());assertEquals(1,new TransferCache(c).completed(api.partition).length());
  Response opened=requests.stream().filter(r->r.getURL().getPath().endsWith("/open")).findFirst().get();assertEquals("application/json",opened.getRequestProperty("Content-Type"));assertEquals("{}",opened.request.toString(StandardCharsets.UTF_8));
  assertNotNull(leases.load(api,id));assertTrue(api.closed);
 }
 @Test public void uploadReleasesNetworkWorkerAtAcceptanceAndMonitorsConversionSeparately()throws Exception{
  Context c=RuntimeEnvironment.getApplication();PlaybackApi api=new PlaybackApi("https://mirea.example.test","c".repeat(43),UUID.randomUUID().toString());
  File file=File.createTempFile("synthetic-upload-",".pdf",c.getCacheDir());try{
   try(FileOutputStream out=new FileOutputStream(file)){out.write("synthetic fixture".getBytes(StandardCharsets.UTF_8));}
   String id=UUID.randomUUID().toString(),shelf=UUID.randomUUID().toString();int[] reads={0};boolean[] complete={false};
   JSONObject state=new JSONObject().put("id",id).put("state","uploading").put("chunkSize",64).put("files",new JSONArray().put(new JSONObject().put("receivedParts",new JSONArray()).put("receivedHashes",new JSONObject())));
   TransferEngine.ConnectionFactory transport=(identity,path,method)->{try{
    if(path.endsWith("/complete"))return new Response(path,method,202,new JSONObject().put("state","processing").toString().getBytes(StandardCharsets.UTF_8));
    if(method.equals("PUT"))return new Response(path,method,204,new byte[0]);
    if(path.equals("/api/v1/uploads/"+id)){reads[0]++;JSONObject status=new JSONObject().put("state",complete[0]?"complete":"processing");if(complete[0])status.put("item",new JSONObject().put("id",id));return new Response(path,method,200,status.toString().getBytes(StandardCharsets.UTF_8));}
    return new Response(path,method,201,state.toString().getBytes(StandardCharsets.UTF_8));
   }catch(Exception error){throw new IOException(error);}};
   JSONObject source=new JSONObject().put("uri",file.toURI().toString()).put("name","fixture.pdf").put("type","application/pdf").put("size",file.length());
   TransferEngine.Job job=new TransferEngine.Job("upload",api,new JSONObject().put("shelfId",shelf).put("title","Synthetic handoff").put("files",new JSONArray().put(source)));
   TransferEngine engine=new TransferEngine(c,()->{},transport,new TransferLease(c));engine.run(job);
   assertEquals("processing",job.state);assertFalse(api.closed);assertEquals(0,reads[0]);
   engine.poll(job);assertEquals("processing",job.state);assertFalse(api.closed);complete[0]=true;engine.poll(job);
   assertEquals("complete",job.state);assertTrue(api.closed);assertEquals(id,job.result.getJSONObject("item").getString("id"));
  }finally{file.delete();}
 }
 @Test public void redirectsNeverTransferBearerOrCreateAnAuthorizedDownload()throws Exception{
  Context c=RuntimeEnvironment.getApplication();PlaybackApi api=new PlaybackApi("https://mirea.example.test","b".repeat(43),UUID.randomUUID().toString());JSONObject m=manifest();int[] requests={0};
  TransferEngine.ConnectionFactory transport=(identity,path,method)->{requests[0]++;try{return new Response(path,method,302,new byte[0]);}catch(Exception e){throw new IOException(e);}};
  TransferEngine.Job job=new TransferEngine.Job("download",api,new JSONObject().put("assetId",m.getString("assetId")).put("title","Redirect denied"));
  new TransferEngine(c,()->{},transport,new TransferLease(c)).run(job);assertEquals("failed",job.state);assertEquals(302,job.status);assertEquals(1,requests[0]);assertEquals(0,new TransferCache(c).completed(api.partition).length());
 }
 @Test public void v2ParallelPartsCompleteAtDurableAcceptanceWithoutConversionPolling()throws Exception{
  Context c=RuntimeEnvironment.getApplication();PlaybackApi api=new PlaybackApi("https://mirea.example.test","d".repeat(43),UUID.randomUUID().toString());
  File file=File.createTempFile("parallel-upload-",".pdf",c.getCacheDir());try{
   byte[] sourceBytes=new byte[262144];new Random(7).nextBytes(sourceBytes);try(FileOutputStream out=new FileOutputStream(file)){out.write(sourceBytes);}
   String id=UUID.randomUUID().toString(),shelf=UUID.randomUUID().toString();java.util.concurrent.CountDownLatch together=new java.util.concurrent.CountDownLatch(2);java.util.concurrent.atomic.AtomicInteger sent=new java.util.concurrent.atomic.AtomicInteger(),polls=new java.util.concurrent.atomic.AtomicInteger();List<Response> requests=Collections.synchronizedList(new ArrayList<>());
   JSONObject state=new JSONObject().put("id",id).put("state","uploading").put("chunkSize",65536).put("maxParallelParts",4).put("files",new JSONArray().put(new JSONObject().put("receivedParts",new JSONArray()).put("receivedHashes",new JSONObject())));
   TransferEngine.ConnectionFactory transport=(identity,path,method)->{try{
    Response r;
    if(method.equals("PUT"))r=new Response(path,method,204,new byte[0]){@Override public int getResponseCode(){sent.incrementAndGet();together.countDown();try{if(!together.await(3,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("Parts must run concurrently");}catch(InterruptedException e){throw new AssertionError(e);}return 204;}};
    else if(path.endsWith("/complete"))r=new Response(path,method,202,new JSONObject().put("state","processing").toString().getBytes(StandardCharsets.UTF_8));
    else if(method.equals("GET")){polls.incrementAndGet();r=new Response(path,method,500,new byte[0]);}
    else r=new Response(path,method,201,state.toString().getBytes(StandardCharsets.UTF_8));
    requests.add(r);return r;
   }catch(Exception e){throw new IOException(e);}};
   JSONObject source=new JSONObject().put("uri",file.toURI().toString()).put("name","parallel.pdf").put("type","application/pdf").put("size",file.length());
   TransferEngine.Job job=new TransferEngine.Job("upload",api,new JSONObject().put("shelfId",shelf).put("title","Parallel handoff").put("files",new JSONArray().put(source)).put("protocolVersion",2).put("monitorProcessing",false));
   new TransferEngine(c,()->{},transport,new TransferLease(c)).run(job);
   assertEquals("complete",job.state);assertTrue(job.result.getBoolean("accepted"));assertEquals(id,job.result.getString("uploadId"));assertTrue(api.closed);assertEquals(4,sent.get());assertEquals(0,polls.get());assertEquals(sourceBytes.length,job.received);
   Response create=requests.stream().filter(r->r.getRequestMethod().equals("POST")&&!r.getURL().getPath().endsWith("/complete")).findFirst().get();assertTrue(new JSONObject(create.request.toString(StandardCharsets.UTF_8)).getBoolean("resume"));
   for(Response r:requests)if(r.getRequestMethod().equals("PUT"))assertEquals(TransferCache.hash(r.request.toByteArray()),r.getRequestProperty("X-Chunk-SHA256"));
  }finally{file.delete();}
 }
}
