package com.suiren.mirea.export;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Write-only, one user-chosen SAF document. No arbitrary paths, file reads,
// persistent directory grants, network requests or broad storage permissions.
@CapacitorPlugin(name="MireaFileExport")
public final class MireaFileExportPlugin extends Plugin {
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private OutputStream output;
    private String handle;
    private long expected,written;
    private boolean choosing,destroyed;
    @PluginMethod public synchronized void begin(PluginCall call){
        String name=call.getString("name"),mime=call.getString("mime");Long size=call.getLong("size");
        if(destroyed||choosing||output!=null){call.reject("別のファイルを保存中です。");return;}
        if(name==null||!name.matches("[A-Za-z0-9._-]{1,180}")||size==null||size<0||size>1099511627776L||!("application/octet-stream".equals(mime)||"application/x-ndjson".equals(mime))){call.reject("保存情報が不正です。");return;}
        if(getActivity()==null){call.reject("アプリを開いて操作してください。");return;}
        choosing=true;
        Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE,name);
        getActivity().runOnUiThread(()->{try{startActivityForResult(call,intent,"documentChosen");}catch(Exception error){synchronized(this){choosing=false;}call.reject("保存先を選択できません。");}});
    }
    @ActivityCallback private void documentChosen(PluginCall call,ActivityResult result){
        if(call==null){synchronized(this){choosing=false;}return;}
        Uri uri=result.getData()==null?null:result.getData().getData();
        if(result.getResultCode()!=Activity.RESULT_OK||uri==null||!"content".equals(uri.getScheme())){synchronized(this){choosing=false;}call.reject("保存を取り消しました。");return;}
        perform(call,()->{synchronized(this){try{
            if(destroyed)throw new IllegalStateException();
            output=getContext().getContentResolver().openOutputStream(uri,"w");if(output==null)throw new IllegalStateException();
            expected=call.getLong("size");written=0;handle=UUID.randomUUID().toString();choosing=false;
            JSObject response=new JSObject();response.put("handle",handle);call.resolve(response);
        }catch(Exception error){choosing=false;closeOutput();call.reject("保存先を開けません。");}}});
    }
    @PluginMethod public void append(PluginCall call){
        String token=call.getString("handle"),data=call.getString("data");
        if(data==null||data.length()>350000){call.reject("保存する分割データが大きすぎます。");return;}
        perform(call,()->{byte[] bytes=null;synchronized(this){try{
            requireHandle(token);bytes=Base64.decode(data,Base64.DEFAULT);
            if(bytes.length>262144||written+bytes.length>expected)throw new IllegalStateException();
            output.write(bytes);written+=bytes.length;call.resolve();
        }catch(Exception error){closeOutput();call.reject("ファイルを保存できません。空き容量を確認してください。");}
        finally{if(bytes!=null)Arrays.fill(bytes,(byte)0);}}});
    }
    @PluginMethod public void finish(PluginCall call){perform(call,()->{synchronized(this){try{requireHandle(call.getString("handle"));if(written!=expected)throw new IllegalStateException();output.flush();output.close();output=null;handle=null;expected=0;written=0;call.resolve();}catch(Exception error){closeOutput();call.reject("保存を完了できません。空き容量・接続・データ長を確認して取得し直してください。");}}});}
    @PluginMethod public void abort(PluginCall call){perform(call,()->{synchronized(this){if(handle!=null&&handle.equals(call.getString("handle")))closeOutput();call.resolve();}});}
    private void perform(PluginCall call,Runnable work){synchronized(this){if(destroyed){call.reject("保存処理は終了しています。");return;}}try{io.execute(work);}catch(RuntimeException error){call.reject("保存処理を開始できません。");}}
    private void requireHandle(String token){if(destroyed||output==null||token==null||!token.equals(handle))throw new IllegalStateException();}
    private void closeOutput(){try{if(output!=null)output.close();}catch(Exception ignored){}output=null;handle=null;expected=0;written=0;}
    @Override protected synchronized void handleOnDestroy(){destroyed=true;closeOutput();io.shutdownNow();}
}
