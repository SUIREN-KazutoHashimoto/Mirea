package com.suiren.mirea.update;

import android.content.*;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.*;

@CapacitorPlugin(name="MireaUpdater")
public final class MireaUpdaterPlugin extends Plugin {
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private UpdateEngine engine;
    private final BroadcastReceiver changed=new BroadcastReceiver(){@Override public void onReceive(Context context,Intent intent){try{notifyListeners("updateState",JSObject.fromJSONObject(engine.status()));}catch(Exception ignored){}}};
    @Override public void load(){
        engine=new UpdateEngine(getContext());
        ContextCompat.registerReceiver(getContext(),changed,new IntentFilter(UpdateEngine.EVENT),ContextCompat.RECEIVER_NOT_EXPORTED);
        engine.schedule();
    }
    @PluginMethod public void getStatus(PluginCall call){try{call.resolve(JSObject.fromJSONObject(engine.status()));}catch(Exception error){call.reject("更新状態を取得できません。");}}
    @PluginMethod public void configure(PluginCall call){
        try{engine.configure(call.getString("serverUrl"),call.getBoolean("automatic"),call.getBoolean("unmeteredOnly"));call.resolve(JSObject.fromJSONObject(engine.status()));}catch(Exception error){call.reject("更新設定を保存できません。HTTPSの接続先を確認してください。");}
    }
    @PluginMethod public void setBusy(PluginCall call){Boolean value=call.getBoolean("busy");if(value==null){call.reject("Busy state is required");return;}UpdateEngine.setBusy(value);call.resolve();}
    @PluginMethod public void check(PluginCall call){
        boolean manual=!Boolean.FALSE.equals(call.getBoolean("manual")),download=Boolean.TRUE.equals(call.getBoolean("download"));
        io.submit(()->{try{engine.run(manual,download);}catch(Exception ignored){}try{call.resolve(JSObject.fromJSONObject(engine.status()));}catch(Exception error){call.reject("更新状態を取得できません。");}});
    }
    @PluginMethod public void requestInstallPermission(PluginCall call){
        if(getActivity()==null){call.reject("アプリを開いて操作してください。");return;}
        getActivity().runOnUiThread(()->{try{getActivity().startActivity(engine.permissionIntent());call.resolve();}catch(Exception error){call.reject("Androidのインストール許可画面を開けません。");}});
    }
    @PluginMethod public void install(PluginCall call){
        io.submit(()->{
            try{
                Intent confirmation=engine.confirmation();
                if(confirmation!=null){getActivity().runOnUiThread(()->{try{getActivity().startActivity(confirmation);call.resolve();}catch(Exception error){call.reject("Androidの確認画面を開けません。更新を確認し直してください。");}});return;}
                engine.installNow();call.resolve(JSObject.fromJSONObject(engine.status()));
            }catch(Exception error){call.reject("更新を適用できません。閲覧・転送を終了し、更新情報とインストール許可を確認してください。");}
        });
    }
    @Override protected void handleOnDestroy(){try{getContext().unregisterReceiver(changed);}catch(Exception ignored){}io.shutdownNow();}
}
