package com.suiren.mirea.transfer;
import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import com.suiren.mirea.playback.PlaybackApi;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;

@CapacitorPlugin(name="MireaTransfer",permissions={@Permission(alias="notifications",strings={Manifest.permission.POST_NOTIFICATIONS})})
public final class MireaTransferPlugin extends Plugin {
    private final Map<String,Uri> selected=new ConcurrentHashMap<>();private final ExecutorService io=Executors.newSingleThreadExecutor();private boolean visible=true;
    private final BroadcastReceiver receiver=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){if(visible)notifyListeners("transferChanged",new JSObject());}};
    @Override public void load(){ContextCompat.registerReceiver(getContext(),receiver,new IntentFilter(TransferService.EVENT),ContextCompat.RECEIVER_NOT_EXPORTED);}
    @PluginMethod public void notifications(PluginCall call){
        if(android.os.Build.VERSION.SDK_INT<33||getPermissionState("notifications")==PermissionState.GRANTED){call.resolve(new JSObject().put("granted",true));return;}
        requestPermissionForAlias("notifications",call,"notificationResult");
    }
    @PermissionCallback private void notificationResult(PluginCall call){call.resolve(new JSObject().put("granted",getPermissionState("notifications")==PermissionState.GRANTED));}
    @PluginMethod public void prepare(PluginCall call){try{ContextCompat.startForegroundService(getContext(),new Intent(getContext(),TransferService.class).setAction("reserve"));call.resolve();}catch(Exception e){call.reject("転送を開始するためアプリを開いてください。");}}
    @PluginMethod public void chooseFiles(PluginCall call){
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call,intent,"chosenFiles");
    }
    @PluginMethod public void chooseFolder(PluginCall call){
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call,intent,"chosenFolder");
    }
    @ActivityCallback private void chosenFolder(PluginCall call,ActivityResult result){
        if(call==null)return;if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null||result.getData().getData()==null){call.resolve(new JSObject().put("files",new JSArray()));return;}
        Uri tree=result.getData().getData();
        io.submit(()->{try{
            if(!"content".equals(tree.getScheme()))throw new IllegalArgumentException();
            getContext().getContentResolver().takePersistableUriPermission(tree,Intent.FLAG_GRANT_READ_URI_PERMISSION);
            String root=DocumentsContract.getTreeDocumentId(tree),name=null;
            try(Cursor c=getContext().getContentResolver().query(DocumentsContract.buildDocumentUriUsingTree(tree,root),new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst())name=c.getString(0);}
            folderName(name);JSArray files=new JSArray();Map<String,Uri> pending=new HashMap<>();Set<String> seen=new HashSet<>();int[] count={0};long deadline=android.os.SystemClock.elapsedRealtime()+30000;
            readFolder(tree,root,name,1,files,pending,seen,count,deadline);
            if(selected.size()+pending.size()>3000)throw new IllegalArgumentException();selected.putAll(pending);call.resolve(new JSObject().put("files",files));
        }catch(Exception e){call.reject("フォルダを取得できません。端末内の100ファイル・16階層以内のフォルダを選んでください。");}});
    }
    private static void folderName(String name){if(name==null||name.trim().isEmpty()||name.length()>200||name.equals(".")||name.equals("..")||name.chars().anyMatch(c->c<32||c==127||c=='/'||c=='\\'))throw new IllegalArgumentException();}
    private void readFolder(Uri tree,String document,String path,int depth,JSArray files,Map<String,Uri> pending,Set<String> seen,int[] count,long deadline)throws Exception{
        if(depth>16||!seen.add(document)||++count[0]>300||android.os.SystemClock.elapsedRealtime()>deadline)throw new IllegalArgumentException();
        String[] columns={DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE,DocumentsContract.Document.COLUMN_LAST_MODIFIED};
        try(Cursor c=getContext().getContentResolver().query(DocumentsContract.buildChildDocumentsUriUsingTree(tree,document),columns,null,null,null)){
            if(c==null)throw new IllegalArgumentException();while(c.moveToNext()){
                if(android.os.SystemClock.elapsedRealtime()>deadline)throw new IllegalArgumentException();String id=c.getString(0),name=c.getString(1),mime=c.getString(2);folderName(name);
                if(DocumentsContract.Document.MIME_TYPE_DIR.equals(mime))readFolder(tree,id,path+"/"+name,depth+1,files,pending,seen,count,deadline);
                else{long size=c.isNull(3)?-1:c.getLong(3);if(size<=0||files.length()>=100)throw new IllegalArgumentException();String key=UUID.randomUUID().toString();Uri uri=DocumentsContract.buildDocumentUriUsingTree(tree,id);pending.put(key,uri);
                    files.put(new JSObject().put("nativeId",key).put("name",name).put("size",size).put("type",mime==null?"application/octet-stream":mime).put("lastModified",c.isNull(4)?0:c.getLong(4)).put("relativePath",path+"/"+name));}
            }
        }
    }
    @ActivityCallback private void chosenFiles(PluginCall call,ActivityResult result){
        if(call==null)return;if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null){call.resolve(new JSObject().put("files",new JSArray()));return;}
        try{
            Intent data=result.getData();List<Uri> uris=new ArrayList<>();if(data.getClipData()!=null){for(int n=0;n<data.getClipData().getItemCount();n++)uris.add(data.getClipData().getItemAt(n).getUri());}else if(data.getData()!=null)uris.add(data.getData());
            if(uris.size()>1000||selected.size()+uris.size()>3000)throw new IllegalArgumentException();JSArray files=new JSArray();
            for(Uri uri:uris){
                if(!"content".equals(uri.getScheme()))throw new IllegalArgumentException();String name=null;long size=-1;
                try(Cursor cursor=getContext().getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE},null,null,null)){if(cursor!=null&&cursor.moveToFirst()){name=cursor.getString(0);size=cursor.getLong(1);}}
                if(name==null||name.length()>255||size<=0)throw new IllegalArgumentException();
                try{getContext().getContentResolver().takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(SecurityException ignored){/* Temporary grants still outlive the picker/activity. */}
                String id=UUID.randomUUID().toString();selected.put(id,uri);String mime=getContext().getContentResolver().getType(uri);
                files.put(new JSObject().put("nativeId",id).put("name",name).put("size",size).put("type",mime==null?"application/octet-stream":mime).put("lastModified",0));
            }
            call.resolve(new JSObject().put("files",files));
        }catch(Exception e){call.reject("ファイルを取得できません。端末内に保存したファイルを選んでください。");}
    }
    private PlaybackApi api(PluginCall c)throws Exception{return new PlaybackApi(c.getString("origin"),c.getString("token"),c.getString("userId"));}
    @PluginMethod public void enqueue(PluginCall call){
        PlaybackApi api=null;String offered=null;
        try{
            api=api(call);String direction=call.getString("direction","");if(!direction.equals("upload")&&!direction.equals("download"))throw new IllegalArgumentException();
            JSONObject data=new JSONObject(call.getObject("job").toString());
            if(direction.equals("upload")){
                JSONArray files=data.getJSONArray("files");if(files.length()<1||files.length()>500)throw new IllegalArgumentException();
                for(int n=0;n<files.length();n++){
                    JSONObject f=files.getJSONObject(n);Uri uri=selected.get(f.getString("nativeId"));if(uri==null||f.getLong("size")<=0||f.getString("name").length()>255)throw new IllegalArgumentException();f.put("uri",uri.toString());
                }
            }else if(!PlaybackApi.uuid(data.getString("assetId")))throw new IllegalArgumentException();
            TransferEngine.Job job=new TransferEngine.Job(direction,api,data);offered=TransferService.offer(job);String id=offered;
            ContextCompat.startForegroundService(getContext(),new Intent(getContext(),TransferService.class).putExtra("id",id));call.resolve(new JSObject().put("id",id));
        }catch(Exception e){if(offered!=null)TransferService.discard(offered);if(api!=null)api.close();call.reject("転送を開始できません。アプリを開いて再試行してください。");}
    }
    @PluginMethod public void status(PluginCall call){try{PlaybackApi api=api(call);try{call.resolve(new JSObject().put("jobs",new JSArray(TransferService.status(api.partition).toString())));}finally{api.close();}}catch(Exception e){call.reject("転送状況を確認できません。");}}
    @PluginMethod public void cancel(PluginCall call){try{PlaybackApi api=api(call);try{String id=call.getString("id");if(id!=null&&!PlaybackApi.uuid(id))throw new IllegalArgumentException();TransferService.cancel(id,api.partition);call.resolve();}finally{api.close();}}catch(Exception e){call.reject("転送を停止できません。");}}
    @PluginMethod public void invalidate(PluginCall call){
        String partition=call.getString("partition","");if(!partition.matches("[0-9a-f]{64}")){call.reject("Invalid partition");return;}
        TransferService.cancel(null,partition);io.submit(()->{new TransferLease(getContext()).clear(partition);call.resolve();});
    }
    @PluginMethod public void completed(PluginCall call){io.submit(()->{PlaybackApi api=null;try{api=api(call);call.resolve(new JSObject().put("manifests",new JSArray(new TransferCache(getContext()).completed(api.partition).toString())));}catch(Exception e){call.reject("保存内容を確認できません。");}finally{if(api!=null)api.close();}});}
    @PluginMethod public void readChunk(PluginCall call){io.submit(()->{PlaybackApi api=null;try{
        api=api(call);byte[] bytes=new TransferCache(getContext()).get(api.partition,call.getString("id"),call.getInt("file",-1),call.getInt("part",-1));if(bytes==null)throw new Exception();
        call.resolve(new JSObject().put("bytes",Base64.getEncoder().encodeToString(bytes)).put("sha256",TransferCache.hash(bytes)));
    }catch(Exception e){call.reject("保存済み分割データを検証できません。");}finally{if(api!=null)api.close();}});}
    @PluginMethod public void lease(PluginCall call){io.submit(()->{PlaybackApi api=null;try{api=api(call);call.resolve(JSObject.fromJSONObject(new TransferLease(getContext()).load(api,call.getString("id"))));}catch(Exception e){call.reject("オフライン視聴期限を確認できません。オンラインで再取得してください。");}finally{if(api!=null)api.close();}});}
    @PluginMethod public void removeAsset(PluginCall call){io.submit(()->{PlaybackApi api=null;try{api=api(call);String asset=call.getString("assetId");if(!PlaybackApi.uuid(asset))throw new IllegalArgumentException();TransferService.cancelAsset(api.partition,asset);new TransferCache(getContext()).removeAsset(api.partition,asset);call.resolve();}catch(Exception e){call.reject("転送中の保存を解除できません。");}finally{if(api!=null)api.close();}});}
    @PluginMethod public void remove(PluginCall call){io.submit(()->{PlaybackApi api=null;try{api=api(call);new TransferCache(getContext()).remove(api.partition,call.getString("id"));new TransferLease(getContext()).revoke(api.partition,call.getString("id"));call.resolve();}catch(Exception e){call.reject("転送用キャッシュを削除できません。");}finally{if(api!=null)api.close();}});}
    @Override protected void handleOnPause(){visible=false;}
    @Override protected void handleOnResume(){visible=true;notifyListeners("transferChanged",new JSObject());}
    @Override protected void handleOnDestroy(){try{getContext().unregisterReceiver(receiver);}catch(Exception ignored){}io.shutdown();}
}
