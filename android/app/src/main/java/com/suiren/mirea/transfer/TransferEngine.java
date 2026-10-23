package com.suiren.mirea.transfer;
import android.content.*;
import android.net.Uri;
import com.suiren.mirea.playback.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Network work is independent of the WebView and dialog lifetime. */
public final class TransferEngine {
    public static final class Job {
        public final String id=UUID.randomUUID().toString(),direction,title;
        public final PlaybackApi api;public final JSONObject data;public volatile String state="queued",error="";public volatile long received,total;public volatile int status;
        public volatile boolean cancelled;public volatile HttpURLConnection connection;public volatile JSONObject result;
        public Job(String direction,PlaybackApi api,JSONObject data)throws Exception{this.direction=direction;this.api=api;this.data=data;title=data.optString("title","Mirea");if(title.length()>200)throw new IllegalArgumentException();}
        public boolean active(){return state.equals("queued")||state.equals("running")||state.equals("processing");}
        public synchronized void cancel(){cancelled=true;api.close();HttpURLConnection c=connection;if(c!=null)c.disconnect();if(active())state="cancelled";}
        public void check()throws IOException{if(cancelled||api.closed||Thread.currentThread().isInterrupted())throw new InterruptedIOException("Transfer stopped");}
        public JSONObject snapshot()throws Exception{return new JSONObject().put("id",id).put("direction",direction).put("title",title).put("state",state).put("received",received).put("total",total).put("percent",total>0?Math.min(100,received*100/total):0).put("status",status).put("error",error).put("result",result==null?JSONObject.NULL:result);}
    }
    interface ConnectionFactory{HttpURLConnection open(PlaybackApi api,String path,String method)throws IOException;}
    private final ConnectionFactory transport;private final TransferLease leases;
    private final Context context;private final TransferCache cache;private final Runnable changed;
    public TransferEngine(Context c,Runnable changed){this(c,changed,(api,path,method)->api.connection(path,method),new TransferLease(c));}
    TransferEngine(Context c,Runnable changed,ConnectionFactory transport,TransferLease leases){context=c;cache=new TransferCache(c);this.changed=changed;this.transport=transport;this.leases=leases;}
    private JSONObject json(Job j,String path,String method,JSONObject body)throws Exception{
        j.check();HttpURLConnection c=transport.open(j.api,"/api/v1"+path,method);j.connection=c;
        try{
            if(body==null&&method.equals("POST"))body=new JSONObject();
            if(body!=null){byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=c.getOutputStream()){out.write(bytes);}}
            int code=c.getResponseCode();if(code<200||code>=300)throw new HttpFailure(code);
            return code==204?new JSONObject():new JSONObject(new String(PlaybackApi.read(c.getInputStream(),4*1024*1024),StandardCharsets.UTF_8));
        }finally{c.disconnect();j.connection=null;}
    }
    static final class HttpFailure extends IOException{final int status;HttpFailure(int s){super("Transfer HTTP "+s);status=s;}}
    interface Work<T>{T run()throws Exception;}
    private <T>T retry(Job j,Work<T> work)throws Exception{
        for(int n=0;;n++)try{j.check();return work.run();}catch(Exception e){j.check();if(n>=3||e instanceof HttpFailure&&((HttpFailure)e).status<500&&!Arrays.asList(408,409,425,429).contains(((HttpFailure)e).status))throw e;pause(j,500L<<n);}
    }
    private void pause(Job j,long ms)throws Exception{for(long n=0;n<ms;n+=100){j.check();Thread.sleep(Math.min(100,ms-n));}}
    public void run(Job j){
        try{j.check();j.state="running";changed.run();if(j.direction.equals("upload"))upload(j);else download(j);j.check();j.state="complete";}
        catch(Exception e){if(!j.cancelled){j.state="failed";j.status=e instanceof HttpFailure?((HttpFailure)e).status:e instanceof PlaybackApi.Failure?((PlaybackApi.Failure)e).status:0;j.error=j.status==401?"ログインの有効期限が切れました。":j.status==403?"転送する権限がありません。":j.status==429?"サーバーの同時処理上限です。転送状況を確認して再試行してください。":"転送に失敗しました。ネットワーク・空き容量を確認して再開してください。";}}
        finally{j.api.close();changed.run();}
    }
    private void download(Job j)throws Exception{
        String asset=j.data.getString("assetId");if(!PlaybackApi.uuid(asset))throw new IllegalArgumentException();
        JSONObject body=new JSONObject();String quality=j.data.optString("quality","");if(!quality.isEmpty()){if(!quality.matches("[0-9]{2,4}p"))throw new IllegalArgumentException();body.put("quality",quality);}
        JSONObject m=DownloadManifest.validate(json(j,"/items/"+asset+"/download","POST",body).getJSONObject("manifest"));
        if(!asset.equals(m.getString("assetId")))throw new IllegalArgumentException();String id=m.getString("id");j.total=DownloadManifest.total(m);synchronized(j){j.check();cache.begin(j.api.partition,m);j.result=new JSONObject().put("manifest",m);}changed.run();
        // Reserve enough free space for the native ciphertext and WebView import.
        if(cache.folder(j.api.partition,id).getUsableSpace()<j.total*2+10485760L)throw new IOException("Insufficient storage");
        JSONArray files=m.getJSONArray("files");
        for(int f=0;f<files.length();f++)for(int p=0;p<files.getJSONObject(f).getInt("chunks");p++){
            j.check();int file=f,part=p;int plain=(int)Math.min(DownloadManifest.CHUNK,files.getJSONObject(f).getLong("size")-(long)p*DownloadManifest.CHUNK);
            if(cache.get(j.api.partition,id,file,part)==null)retry(j,()->{
                HttpURLConnection c=transport.open(j.api,"/api/v1/downloads/"+id+"/files/"+file+"/parts/"+part,"GET");j.connection=c;
                try{int code=c.getResponseCode();if(code!=200)throw new HttpFailure(code);byte[] bytes=PlaybackApi.read(c.getInputStream(),DownloadManifest.CHUNK+28);j.check();cache.put(j.api.partition,id,file,part,bytes,c.getHeaderField("X-Chunk-SHA256"));return null;}finally{c.disconnect();j.connection=null;}
            });
            j.received+=plain;changed.run();
        }
        j.check();JSONObject grant=json(j,"/downloads/"+id+"/open","POST",null);
        if(!grant.getJSONObject("manifest").getString("id").equals(id))throw new IOException("Lease mismatch");
        try{
            HttpURLConnection cover=transport.open(j.api,"/api/v1/items/"+asset+"/thumbnail","GET");j.connection=cover;
            try{if(cover.getResponseCode()==200){byte[] image=PlaybackApi.read(cover.getInputStream(),262144);grant.put("cover",new JSONObject().put("mime","image/jpeg").put("bytes",Base64.getEncoder().encodeToString(image)));}}finally{cover.disconnect();j.connection=null;}
        }catch(IOException ignored){/* Missing artwork cannot invalidate encrypted content. */}
        synchronized(j){j.check();leases.save(j.api,grant);}grant.remove("cover");
        if(m.getString("kind").equals("audio")||m.getString("kind").equals("video")){
            synchronized(j){j.check();new OfflineLease(context).save(j.api,grant);}PlaybackCache player=new PlaybackCache(context);
            if(!player.begin(j.api.partition,m)){JSONObject f=files.getJSONObject(0);for(int p=0;p<f.getInt("chunks");p++){j.check();byte[] b=cache.get(j.api.partition,id,0,p);player.put(j.api.partition,id,p,b,TransferCache.hash(b));}player.complete(j.api.partition,id);}
        }
        grant.remove("key");cache.complete(j.api.partition,id);j.result=new JSONObject().put("manifest",m);
    }
    private InputStream input(JSONObject f)throws Exception{return context.getContentResolver().openInputStream(Uri.parse(f.getString("uri")));}
    static byte[] readPart(InputStream input,int length)throws IOException{byte[] bytes=new byte[length];int offset=0;while(offset<length){int n=input.read(bytes,offset,length-offset);if(n<0)throw new EOFException("Source file changed");offset+=n;}return bytes;}
    private void upload(Job j)throws Exception{
        JSONArray files=j.data.getJSONArray("files"),publicFiles=new JSONArray(),identities=new JSONArray();j.total=0;
        for(int f=0;f<files.length();f++){
            JSONObject file=files.getJSONObject(f);long size=file.getLong("size");if(size<=0)throw new IllegalArgumentException();j.total+=size;
            publicFiles.put(new JSONObject().put("filename",file.getString("name")).put("mime",file.getString("type")).put("size",size));
            // Fingerprint the complete stream incrementally. No large allocation
            // or cleartext staging file, and a reselected middle cannot be mixed.
            java.security.MessageDigest hash=java.security.MessageDigest.getInstance("SHA-256");long count=0;
            try(InputStream in=input(file)){byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1){j.check();hash.update(bytes,0,n);count+=n;}}
            if(count!=size)throw new IOException("Source file changed");
            identities.put(new JSONArray().put(file.getString("name")).put(file.getString("type")).put(size).put(Base64.getEncoder().encodeToString(hash.digest())));
        }
        String shelf=j.data.getString("shelfId");if(!PlaybackApi.uuid(shelf))throw new IllegalArgumentException();
        String fingerprint=TransferCache.hash((j.api.partition+"|"+shelf+"|"+j.title+"|"+j.data.optBoolean("retainOriginal",true)+"|"+j.data.optString("seriesId","")+"|"+identities).getBytes(StandardCharsets.UTF_8));
        SharedPreferences prefs=context.getSharedPreferences("mirea-upload-resume-v1",Context.MODE_PRIVATE);String saved=prefs.getString(fingerprint,null);JSONObject state=null;
        if(PlaybackApi.uuid(saved))try{state=retry(j,()->json(j,"/uploads/"+saved,"GET",null));if(Arrays.asList("cancelled","failed").contains(state.getString("state")))state=null;}catch(HttpFailure e){if(e.status!=404&&e.status!=410)throw e;}
        if(state==null){JSONObject body=new JSONObject().put("title",j.title).put("retainOriginal",j.data.optBoolean("retainOriginal",true)).put("files",publicFiles);String series=j.data.optString("seriesId","");if(!series.isEmpty()){if(!PlaybackApi.uuid(series))throw new IllegalArgumentException();body.put("seriesId",series);}
            state=json(j,"/shelves/"+shelf+"/uploads","POST",body);prefs.edit().putString(fingerprint,state.getString("id")).commit();
        }
        String id=state.getString("id");j.data.put("uploadId",id);
        if("uploading".equals(state.getString("state"))){
            int chunk=state.getInt("chunkSize");if(chunk<1||chunk>16777216)throw new IllegalArgumentException();
            for(int f=0;f<files.length();f++){
                JSONObject file=files.getJSONObject(f),server=state.getJSONArray("files").getJSONObject(f),hashes=server.optJSONObject("receivedHashes");Set<Integer> received=new HashSet<>();JSONArray parts=server.getJSONArray("receivedParts");for(int n=0;n<parts.length();n++)received.add(parts.getInt(n));
                try(InputStream in=input(file)){
                    long size=file.getLong("size");for(int p=0;(long)p*chunk<size;p++){
                        j.check();byte[] bytes=readPart(in,(int)Math.min(chunk,size-(long)p*chunk));String sha=TransferCache.hash(bytes);int fileIndex=f,part=p;
                        if(received.contains(p)){if(hashes==null||!sha.equals(hashes.optString(String.valueOf(p))))throw new IOException("Source bytes changed");}
                        else retry(j,()->{
                            HttpURLConnection c=transport.open(j.api,"/api/v1/uploads/"+id+"/files/"+fileIndex+"/parts/"+part,"PUT");j.connection=c;c.setReadTimeout(90000);
                            try{c.setDoOutput(true);c.setRequestProperty("Content-Type","application/octet-stream");c.setRequestProperty("X-Chunk-SHA256",sha);c.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=c.getOutputStream()){for(int n=0;n<bytes.length;n+=65536){j.check();out.write(bytes,n,Math.min(65536,bytes.length-n));}}
                                int code=c.getResponseCode();if(code!=204)throw new HttpFailure(code);return null;
                            }finally{c.disconnect();j.connection=null;}
                        });
                        j.received+=bytes.length;changed.run();
                    }
                }
            }
            state=retry(j,()->json(j,"/uploads/"+id+"/complete","POST",null));
        }
        j.state="processing";changed.run();
        while("processing".equals(state.getString("state"))){pause(j,1500);state=retry(j,()->json(j,"/uploads/"+id,"GET",null));changed.run();}
        if(!"complete".equals(state.getString("state"))||!state.has("item"))throw new IOException("Server processing failed");
        prefs.edit().remove(fingerprint).commit();j.result=new JSONObject().put("item",state.getJSONObject("item")).put("seriesWarning",state.optString("seriesWarning",""));
    }
}
