package com.suiren.mirea.playback;

import android.content.*;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;

@CapacitorPlugin(name="MireaPlayback")
public final class MireaPlaybackPlugin extends Plugin {
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private PlaybackCache cache;
    private volatile boolean visible;
    private final BroadcastReceiver changed=new BroadcastReceiver(){public void onReceive(Context c,Intent i){if(visible)notifyListeners("playbackState",state());}};
    private JSObject state(){try{PlaybackService s=PlaybackService.current;return s==null?new JSObject().put("active",false):JSObject.fromJSONObject(s.status());}catch(Exception e){return new JSObject().put("active",false);}}
    @Override public void load(){cache=new PlaybackCache(getContext());ContextCompat.registerReceiver(getContext(),changed,new IntentFilter(PlaybackService.EVENT),ContextCompat.RECEIVER_NOT_EXPORTED);}
    @PluginMethod public void play(PluginCall call){getActivity().runOnUiThread(()->{PlaybackService s=PlaybackService.current;if(s!=null)s.play();call.resolve(state());});}
    @PluginMethod public void pause(PluginCall call){getActivity().runOnUiThread(()->{PlaybackService s=PlaybackService.current;if(s!=null)s.pause();call.resolve(state());});}
    @PluginMethod public void status(PluginCall call){call.resolve(state());}
    @PluginMethod public void open(PluginCall call){
        try{JSONObject data=new JSONObject(call.getData().toString());PlaybackApi validation=new PlaybackApi(data.getString("origin"),data.getString("token"),data.getString("userId"));validation.close();
            String nonce=PlaybackService.offer(data);getActivity().runOnUiThread(()->{try{ContextCompat.startForegroundService(getContext(),new Intent(getContext(),PlaybackService.class).setAction("open").putExtra("request",nonce));getActivity().startActivity(new Intent(getContext(),PlaybackActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));call.resolve();}catch(Exception e){PlaybackService.discard(nonce);call.reject("再生サービスを開始できません。アプリを開いて再試行してください。");}});
        }catch(Exception e){call.reject("再生情報が不正です。");}
    }
    @PluginMethod public void show(PluginCall call){getActivity().runOnUiThread(()->{if(PlaybackService.current==null){call.reject("再生中のアセットがありません。");return;}getActivity().startActivity(new Intent(getContext(),PlaybackActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));call.resolve();});}
    @PluginMethod public void stop(PluginCall call){getActivity().runOnUiThread(()->{PlaybackService service=PlaybackService.current;if(service==null){call.resolve(new JSObject().put("active",false));return;}getContext().stopService(new Intent(getContext(),PlaybackService.class));io.submit(()->{try{service.stopped.get(45,TimeUnit.SECONDS);call.resolve(new JSObject().put("active",false));}catch(Exception e){call.reject("再生の終了処理を確認できません。少し待って再試行してください。");}});});}
    @PluginMethod public void leaseSave(PluginCall call){io.submit(()->{try(PlaybackApiScope scope=new PlaybackApiScope(call)){JSONObject grant=scope.api.json("/downloads/"+call.getString("id")+"/open","POST",null);new OfflineLease(getContext()).save(scope.api,grant);String asset=grant.getJSONObject("manifest").getString("assetId");try(PlaybackJournal journal=new PlaybackJournal(getContext())){new PlaybackProgress(scope.api,journal,asset);}grant.remove("key");call.resolve();}catch(Exception e){call.reject("オフライン視聴期限を更新できません。");}});}
    private static final class PlaybackApiScope implements AutoCloseable{final PlaybackApi api;PlaybackApiScope(PluginCall c)throws Exception{api=new PlaybackApi(c.getString("origin"),c.getString("token"),c.getString("userId"),c.getString("shelfUnlock",""));}public void close(){api.close();}}
    @PluginMethod public void leaseRevoke(PluginCall call){io.submit(()->{try{new OfflineLease(getContext()).revoke(call.getString("partition"),call.getString("id"));PlaybackService s=PlaybackService.current;if(s!=null)s.revokeDownload(call.getString("partition"),call.getString("id"));call.resolve();}catch(Exception e){call.reject("閲覧許可を無効化できません。");}});}
    @PluginMethod public void leaseClear(PluginCall call){io.submit(()->{try{new OfflineLease(getContext()).clear(call.getString("partition"));call.resolve();}catch(Exception e){call.reject("閲覧許可を無効化できません。");}});}
    @PluginMethod public void synchronize(PluginCall call){io.submit(()->{try(PlaybackApiScope scope=new PlaybackApiScope(call);PlaybackJournal journal=new PlaybackJournal(getContext())){
        journal.synchronizeProgress(scope.api);for(int n=0;n<20;n++)journal.flush(scope.api);call.resolve();
    }catch(Exception e){call.reject("再生記録は接続後に再送します。");}});}
    @PluginMethod public void cacheBegin(PluginCall call){io.submit(()->{try{PlaybackApi api=new PlaybackApi(call.getString("origin"),call.getString("token"),call.getString("userId"));try{boolean ready=cache.begin(api.partition,call.getObject("manifest"));call.resolve(new JSObject().put("partition",api.partition).put("ready",ready));}finally{api.close();}}catch(Exception e){call.reject("暗号化再生の準備に失敗しました。保存容量を確認してください。");}});}
    @PluginMethod public void cacheChunk(PluginCall call){io.submit(()->{byte[] bytes=null;try{String base64=call.getString("bytes","");if(base64.length()>1400000)throw new Exception();bytes=Base64.getDecoder().decode(base64);cache.put(call.getString("partition"),call.getString("id"),call.getInt("part",-1),bytes,call.getString("sha256",""));call.resolve();}catch(Exception e){call.reject("暗号化データを転送できません。");}finally{if(bytes!=null)Arrays.fill(bytes,(byte)0);}});}
    @PluginMethod public void cacheComplete(PluginCall call){io.submit(()->{try{cache.complete(call.getString("partition"),call.getString("id"));call.resolve();}catch(Exception e){call.reject("保存データが不足しています。");}});}
    @PluginMethod public void cacheRemove(PluginCall call){io.submit(()->{try{cache.remove(call.getString("partition"),call.getString("id"));call.resolve();}catch(Exception e){call.reject("端末の暗号化データを削除できません。");}});}
    @PluginMethod public void cacheClear(PluginCall call){io.submit(()->{try{cache.clear(call.getString("partition"));call.resolve();}catch(Exception e){call.reject("端末の暗号化データを削除できません。");}});}
    @PluginMethod public void clearHistory(PluginCall call){io.submit(()->{try{String partition=call.getString("partition","");if(!partition.matches("[0-9a-f]{64}"))throw new Exception();try(PlaybackJournal journal=new PlaybackJournal(getContext())){journal.clear(partition);}call.resolve();}catch(Exception e){call.reject("端末内の再生記録を削除できません。");}});}
    @Override protected void handleOnResume(){visible=true;notifyListeners("playbackState",state());}
    @Override protected void handleOnPause(){visible=false;}
    @Override protected void handleOnDestroy(){try{getContext().unregisterReceiver(changed);}catch(Exception ignored){}io.shutdown();}
}
