package com.suiren.mirea.playback;

import android.app.*;
import android.content.*;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.*;
import android.os.*;
import android.util.Rational;
import android.view.*;
import android.view.accessibility.AccessibilityManager;
import android.widget.*;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.*;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import org.json.*;
import java.util.*;

/** Immersive presentation only; rotation never opens, pauses or replaces the service's player. */
public final class PlaybackActivity extends ComponentActivity implements SurfaceHolder.Callback {
    private FrameLayout root;
    private SurfaceView video;
    private PlaybackScreen screen;
    private PlaybackService surfaceService;
    private Surface boundSurface;
    private PlaybackPresentation.Orientation orientation;
    private final PlaybackPresentation.Chrome chrome=new PlaybackPresentation.Chrome();
    private final ArrayList<Dialog> dialogs=new ArrayList<>();
    private boolean visible,preserve,backgroundRequested,scrubbing,destroyed;
    private Boolean windowVideo;
    private long createdAt;
    private float zoom=1,panX,panY;private String shownAsset="";
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable tick=new Runnable(){public void run(){if(destroyed)return;render();handler.postDelayed(this,500);}};
    private final BroadcastReceiver changed=new BroadcastReceiver(){public void onReceive(Context c,Intent i){render();}};
    private PlaybackService service(){return PlaybackService.current;}
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);createdAt=SystemClock.elapsedRealtime();orientation=new PlaybackPresentation.Orientation(saved==null?0:saved.getInt("orientationMode"));
        getOnBackPressedDispatcher().addCallback(this,new OnBackPressedCallback(true){public void handleOnBackPressed(){if(screen==null||!screen.cancelPrecise())closePlayback();}});
        setVolumeControlStream(android.media.AudioManager.STREAM_MUSIC);
        WindowCompat.setDecorFitsSystemWindows(getWindow(),false);getWindow().setStatusBarColor(Color.TRANSPARENT);getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowManager.LayoutParams attributes=getWindow().getAttributes();attributes.layoutInDisplayCutoutMode=Build.VERSION.SDK_INT>=30?WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS:WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;getWindow().setAttributes(attributes);
        root=new FrameLayout(this);root.setBackgroundColor(Color.BLACK);setContentView(root);
        video=new SurfaceView(this);video.getHolder().addCallback(this);root.addView(video,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
        screen=new PlaybackScreen(this,new PlaybackScreen.Actions(){
            public void perform(String action){act(action);}
            public void seek(long position){if(service()!=null)service().seek(position);}
            public void scrub(boolean value){scrubbing=value;chrome.interact(SystemClock.elapsedRealtime());render();}
            public void boost(boolean value){if(service()!=null){if(value)service().startBoost();else service().endBoost();}chrome.interact(SystemClock.elapsedRealtime());render();}
            public void zoom(float scale,float dx,float dy){zoom=scale;panX+=dx;panY+=dy;applyZoom();}
        });root.addView(screen,new FrameLayout.LayoutParams(-1,-1));
        ViewCompat.setOnApplyWindowInsetsListener(root,(v,insets)->{
            Insets safe=insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout()),gestures=insets.getInsets(WindowInsetsCompat.Type.systemGestures());
            screen.setSafeInsets(Math.max(safe.left,gestures.left),safe.top,Math.max(safe.right,gestures.right),Math.max(safe.bottom,gestures.bottom));return insets;
        });ViewCompat.requestApplyInsets(root);
        root.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->{if(r-l!=or-ol||b-t!=ob-ot)fitVideo();});
        ContextCompat.registerReceiver(this,changed,new IntentFilter(PlaybackService.EVENT),ContextCompat.RECEIVER_NOT_EXPORTED);handler.post(tick);
    }
    private void act(String action){
        screen.cancelHold();if(service()!=null)service().endBoost();long now=SystemClock.elapsedRealtime();if(action.equals("toggle-chrome")){chrome.toggle(now);render();return;}chrome.interact(now);PlaybackService s=service();
        switch(action){
            case "close":closePlayback();return;
            case "rotate":{
                if(isInMultiWindowMode()||Build.VERSION.SDK_INT>=36&&getResources().getConfiguration().smallestScreenWidthDp>=600){Toast.makeText(this,"この画面では、端末の向きやウィンドウの大きさに合わせて表示します。",Toast.LENGTH_SHORT).show();break;}
                boolean landscape=getResources().getConfiguration().orientation==Configuration.ORIENTATION_LANDSCAPE;
                orientation.toggle(landscape);applyOrientation();screen.landscape(!landscape);break;
            }
            case "options":options();break;
            case "quality":qualities();break;
            case "speed":speeds();break;
            case "chapters":chapters();break;
            case "precise":if(!screen.preciseSeek())Toast.makeText(this,"場面画像がまだありません。準備後に再度お試しください。",Toast.LENGTH_LONG).show();break;
            case "captions":captions();break;
            case "caption-size":captionSizes();break;
            case "network-quality":networkQualities();break;
            case "pause-scrub":if(s!=null)s.pause();break;
            case "resume-scrub":if(s!=null)s.play();break;
            case "zoom-reset":screen.resetZoom();zoom=1;panX=panY=0;applyZoom();break;
            case "pip":enterPip();break;
            case "background":backgroundRequested=true;preserve=true;configurePip(false);moveTaskToBack(true);break;
            case "library":preserve=true;configurePip(false);finish();return;
            case "play":if(s!=null){if(s.playing())s.pause();else s.play();}break;
            case "rewind":if(s!=null)s.seek(s.position()-10000);break;
            case "forward":if(s!=null)s.seek(s.position()+10000);break;
            case "previous":if(s!=null)s.navigate(-1);break;
            case "next":if(s!=null)s.navigate(1);break;
            case "continuous":if(s!=null)s.continuous(!s.status().optBoolean("continuous"));break;
            case "mute":if(s!=null)s.mute();break;
            case "reconnect":if(s!=null)s.reconnect();break;
            default:break;
        }
        render();
    }
    private void options(){
        PlaybackService s=service();JSONObject state=s==null?new JSONObject():s.status();ArrayList<String> names=new ArrayList<>(),actions=new ArrayList<>();
        if(s!=null&&s.video()){if(canPip()){names.add("ピクチャーインピクチャー（PiP）");actions.add("pip");}if(!state.optBoolean("download")){names.add("画質を選択");actions.add("quality");names.add("Wi-Fi／モバイル通信の画質設定");actions.add("network-quality");}names.add("精密シーク（場面画像から選ぶ）");actions.add("precise");names.add("チャプター"+(state.optString("chapter").isEmpty()?"":"："+state.optString("chapter")));actions.add("chapters");names.add("字幕の言語・オン／オフ");actions.add("captions");names.add("字幕の文字サイズ");actions.add("caption-size");names.add("ズームをリセット");actions.add("zoom-reset");}
        names.add("再生速度");actions.add("speed");names.add(state.optBoolean("muted")?"消音を解除":"消音にする");actions.add("mute");names.add("連続再生："+(state.optBoolean("continuous")?"オン":"オフ"));actions.add("continuous");
        names.add("前の作品");actions.add("previous");names.add("次の作品");actions.add("next");names.add("バックグラウンドで再生");actions.add("background");names.add("ライブラリへ戻る（再生を継続）");actions.add("library");names.add("再接続");actions.add("reconnect");names.add("再生を終了");actions.add("close");
        show(new AlertDialog.Builder(this).setTitle("再生オプション").setItems(names.toArray(new String[0]),(d,index)->act(actions.get(index))).setNegativeButton("閉じる",null).create());
    }
    private void qualities(){PlaybackService s=service();if(s==null||!s.video()||s.status().optBoolean("download"))return;try{
        JSONObject state=s.status();JSONArray values=state.getJSONArray("qualities");ArrayList<String> names=new ArrayList<>(),ids=new ArrayList<>();if(values.length()>0){names.add("自動（通信状態に合わせる）");ids.add("auto");names.add("高画質優先");ids.add("higher");names.add("データセーバー（480p以下）");ids.add("data");}names.add("標準（基本MP4）");ids.add("legacy");for(int n=0;n<values.length();n++){String q=values.getJSONObject(n).getString("quality");names.add(q+"（固定）");ids.add(q);}int selected=Math.max(0,ids.indexOf(state.optString("quality","auto")));
        show(new AlertDialog.Builder(this).setTitle("画質（次の動画にも適用）").setSingleChoiceItems(names.toArray(new String[0]),selected,(d,i)->{if(service()!=null)service().quality(ids.get(i));d.dismiss();}).setNegativeButton("閉じる",null).create());
    }catch(JSONException ignored){}}
    private void speeds(){PlaybackService s=service();float[] rates={.25f,.5f,.75f,1,1.25f,1.5f,1.75f,2};double rate=s==null?1:s.status().optDouble("rate",1);int selected=3;for(int i=0;i<rates.length;i++)if(Math.abs(rates[i]-rate)<.01)selected=i;
        show(new AlertDialog.Builder(this).setTitle("再生速度").setSingleChoiceItems(new String[]{"0.25×","0.5×","0.75×","1×（標準）","1.25×","1.5×","1.75×","2×"},selected,(d,index)->{if(service()!=null)service().speed(rates[index]);d.dismiss();}).setNegativeButton("閉じる",null).create());
    }
    private void chapters(){PlaybackService s=service();JSONArray list=s==null||s.navigation==null?null:s.navigation.optJSONArray("chapters");if(list==null||list.length()==0){Toast.makeText(this,"チャプターがありません。ライブラリの「チャプター・字幕」から追加できます。",Toast.LENGTH_LONG).show();return;}String[] names=new String[list.length()];for(int n=0;n<names.length;n++){JSONObject c=list.optJSONObject(n);names[n]=PlaybackPresentation.time(c.optLong("startMs"))+" "+c.optString("title");}show(new AlertDialog.Builder(this).setTitle("チャプター").setItems(names,(d,n)->{if(service()!=null)service().seek(list.optJSONObject(n).optLong("startMs"));}).setNegativeButton("閉じる",null).create());}
    private void captions(){PlaybackService s=service();JSONArray list=s==null||s.navigation==null?null:s.navigation.optJSONArray("captions");ArrayList<String> names=new ArrayList<>(),ids=new ArrayList<>();names.add("字幕なし");ids.add("off");if(list!=null)for(int n=0;n<list.length();n++){JSONObject c=list.optJSONObject(n);if(c!=null){names.add(c.optString("label"));ids.add(c.optString("id"));}}show(new AlertDialog.Builder(this).setTitle("字幕（準備中は後で再表示）").setItems(names.toArray(new String[0]),(d,n)->{if(service()!=null)service().captions(ids.get(n));}).setNegativeButton("閉じる",null).create());}
    private void captionSizes(){show(new AlertDialog.Builder(this).setTitle("字幕の文字サイズ").setItems(new String[]{"小","標準","大","特大"},(d,n)->{if(service()!=null)service().captionSize(new int[]{16,20,26,32}[n]);}).setNegativeButton("閉じる",null).create());}
    private void networkQualities(){show(new AlertDialog.Builder(this).setTitle("どの回線の初期画質を変更しますか？").setItems(new String[]{"Wi-Fi","モバイル通信"},(d,n)->show(new AlertDialog.Builder(this).setTitle(n==0?"Wi-Fiの画質":"モバイル通信の画質").setItems(new String[]{"自動","高画質優先","データセーバー"},(dialog,i)->{if(service()!=null)service().networkPreference(n==0?"wifi":"mobile",new String[]{"auto","higher","data"}[i]);}).setNegativeButton("閉じる",null).create())).setNegativeButton("閉じる",null).create());}
    private void show(Dialog d){dialogs.add(d);d.setOnDismissListener(value->{dialogs.remove(d);chrome.interact(SystemClock.elapsedRealtime());if(!destroyed)render();});d.show();}
    private void render(){
        if(destroyed||screen==null)return;PlaybackService s=service();if(s==null){try{boolean starting=SystemClock.elapsedRealtime()-createdAt<2000;screen.bind(new JSONObject().put("video",true).put("buffering",starting).put("error",starting?"":"再生を終了しました。ライブラリから開いてください。"),null);}catch(JSONException ignored){}return;}
        boolean inPip=isInPictureInPictureMode();s.visibility(visible&&!inPip,inPip);JSONObject state=s.status();boolean isVideo=s.video();
        JSONObject current=state.optJSONObject("item");String id=current==null?"":current.optString("id");if(!shownAsset.equals(id)){shownAsset=id;screen.resetZoom();zoom=1;panX=panY=0;applyZoom();}screen.navigation(s.navigation,s.storyboard);
        video.setVisibility(isVideo?View.VISIBLE:View.GONE);screen.bind(state,s.artwork);screen.setPip(inPip);
        AccessibilityManager accessibility=getSystemService(AccessibilityManager.class);boolean assisted=accessibility!=null&&accessibility.isTouchExplorationEnabled();boolean busy=scrubbing||!dialogs.isEmpty()||state.optBoolean("buffering")||!state.optString("error").isEmpty();
        screen.setChromeVisible(chrome.update(SystemClock.elapsedRealtime(),isVideo,s.playing(),busy,assisted,inPip));screen.landscape(getResources().getConfiguration().orientation==Configuration.ORIENTATION_LANDSCAPE);
        if(isVideo){Surface surface=video.getHolder().getSurface();if(surface!=null&&surface.isValid()&&(s!=surfaceService||surface!=boundSurface))attach(surface);fitVideo();}
        if(isVideo&&s.playing()&&visible&&!inPip)getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if(windowVideo==null||windowVideo!=isVideo){windowVideo=isVideo;applySystemBars();}
        applyOrientation();configurePip(!backgroundRequested&&isVideo&&s.playing());
    }
    private void fitVideo(){PlaybackService s=service();if(video==null||s==null||!s.video()||root.getWidth()<=0)return;JSONObject state=s.status();int[] size=PlaybackPresentation.fit(root.getWidth(),root.getHeight(),state.optInt("width",16),state.optInt("height",9));FrameLayout.LayoutParams p=(FrameLayout.LayoutParams)video.getLayoutParams();if(p.width!=size[0]||p.height!=size[1]){p.width=size[0];p.height=size[1];p.gravity=Gravity.CENTER;video.setLayoutParams(p);}applyZoom();}
    private void applyZoom(){if(video==null)return;float maxX=Math.max(0,(video.getWidth()*zoom-root.getWidth())/2),maxY=Math.max(0,(video.getHeight()*zoom-root.getHeight())/2);panX=Math.max(-maxX,Math.min(maxX,panX));panY=Math.max(-maxY,Math.min(maxY,panY));video.setScaleX(zoom);video.setScaleY(zoom);video.setTranslationX(panX);video.setTranslationY(panY);}
    @Override public boolean onKeyDown(int key,KeyEvent e){PlaybackService s=service();if(s==null||!dialogs.isEmpty()||e.getAction()!=KeyEvent.ACTION_DOWN)return super.onKeyDown(key,e);if(key==KeyEvent.KEYCODE_SPACE||key==KeyEvent.KEYCODE_K)act("play");else if(key==KeyEvent.KEYCODE_J||key==KeyEvent.KEYCODE_L)s.seek(s.position()+(key==KeyEvent.KEYCODE_L?10000:-10000));else if(key==KeyEvent.KEYCODE_DPAD_LEFT||key==KeyEvent.KEYCODE_DPAD_RIGHT){int direction=key==KeyEvent.KEYCODE_DPAD_RIGHT?1:-1;s.seek(e.isCtrlPressed()?VideoNavigation.chapterPosition(s.navigation,s.position(),direction):s.position()+direction*5000);}else if(e.isShiftPressed()&&(key==KeyEvent.KEYCODE_N||key==KeyEvent.KEYCODE_P))s.navigate(key==KeyEvent.KEYCODE_N?1:-1);else if(key>=KeyEvent.KEYCODE_0&&key<=KeyEvent.KEYCODE_9)s.seek(s.duration()*(key-KeyEvent.KEYCODE_0)/10);else if(key==KeyEvent.KEYCODE_M)act("mute");else if(key==KeyEvent.KEYCODE_F)act("rotate");else if(key==KeyEvent.KEYCODE_I)act("background");else if(key==KeyEvent.KEYCODE_C)act("captions");else if(key==KeyEvent.KEYCODE_PERIOD||key==KeyEvent.KEYCODE_COMMA){int direction=key==KeyEvent.KEYCODE_PERIOD?1:-1;if(e.isShiftPressed())s.speed((float)s.status().optDouble("rate",1)+direction*.25f);else if(!s.playing())s.seek(s.position()+direction*33);}else return super.onKeyDown(key,e);chrome.interact(SystemClock.elapsedRealtime());render();return true;}
    private void applySystemBars(){if(isInPictureInPictureMode())return;WindowInsetsControllerCompat controller=WindowCompat.getInsetsController(getWindow(),root);controller.setAppearanceLightStatusBars(false);controller.setAppearanceLightNavigationBars(false);controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);if(Boolean.FALSE.equals(windowVideo))controller.show(WindowInsetsCompat.Type.systemBars());else controller.hide(WindowInsetsCompat.Type.systemBars());}
    private void applyOrientation(){
        PlaybackService s=service();if(s==null||!visible||isInPictureInPictureMode()||isInMultiWindowMode()||Build.VERSION.SDK_INT>=36&&getResources().getConfiguration().smallestScreenWidthDp>=600)return;JSONObject state=s.status();int target=orientation.target(s.video(),state.optBoolean("prepared"),state.optInt("width"),state.optInt("height"));int requested=target==PlaybackPresentation.Orientation.LANDSCAPE?ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE:target==PlaybackPresentation.Orientation.PORTRAIT?ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT:ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        // Keep the current video orientation during preparation/quality changes.
        if(s.video()&&target==PlaybackPresentation.Orientation.AUTOMATIC)return;
        if(getRequestedOrientation()!=requested)setRequestedOrientation(requested);
    }
    private boolean canPip(){return getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);}
    private PictureInPictureParams params(boolean auto){PlaybackService s=service();JSONObject state=s==null?new JSONObject():s.status();double ratio=state.optInt("width",16)/(double)Math.max(1,state.optInt("height",9));ratio=Math.max(1/2.39,Math.min(2.39,ratio));PictureInPictureParams.Builder b=new PictureInPictureParams.Builder().setAspectRatio(new Rational((int)(ratio*1000),1000));Rect rect=new Rect();if(video.getGlobalVisibleRect(rect)&&!rect.isEmpty())b.setSourceRectHint(rect);if(Build.VERSION.SDK_INT>=31)b.setAutoEnterEnabled(auto).setSeamlessResizeEnabled(true);return b.build();}
    private void configurePip(boolean auto){if(canPip())try{setPictureInPictureParams(params(auto));}catch(IllegalArgumentException|IllegalStateException ignored){}}
    private void enterPip(){PlaybackService s=service();if(s==null||!s.video()||!canPip()){Toast.makeText(this,"この端末ではPiPを利用できません。",Toast.LENGTH_SHORT).show();return;}try{enterPictureInPictureMode(params(false));}catch(IllegalStateException|IllegalArgumentException e){Toast.makeText(this,"PiPに切り替えられません。",Toast.LENGTH_SHORT).show();}}
    @Override public void onUserLeaveHint(){super.onUserLeaveHint();PlaybackService s=service();if(Build.VERSION.SDK_INT<31&&!backgroundRequested&&s!=null&&s.video()&&s.playing())enterPip();}
    @Override public void onPictureInPictureModeChanged(boolean value,Configuration config){super.onPictureInPictureModeChanged(value,config);if(screen!=null){screen.setPip(value);if(value){screen.resetZoom();zoom=1;panX=panY=0;applyZoom();}}chrome.interact(SystemClock.elapsedRealtime());if(service()!=null)service().visibility(!value&&visible,value);if(!value)applySystemBars();render();}
    @Override public void onConfigurationChanged(Configuration config){if(screen!=null){screen.cancelHold();screen.cancelScrub();}super.onConfigurationChanged(config);chrome.interact(SystemClock.elapsedRealtime());fitVideo();render();ViewCompat.requestApplyInsets(root);}
    @Override public void onWindowFocusChanged(boolean focus){super.onWindowFocusChanged(focus);if(!focus&&screen!=null){screen.cancelHold();screen.cancelScrub();}if(focus&&root!=null)applySystemBars();}
    @Override public void onSaveInstanceState(Bundle out){out.putInt("orientationMode",orientation.manual());super.onSaveInstanceState(out);}
    @Override public void onResume(){super.onResume();visible=true;backgroundRequested=false;chrome.interact(SystemClock.elapsedRealtime());if(service()!=null)service().visibility(true,isInPictureInPictureMode());render();}
    @Override public void onPause(){if(screen!=null){screen.cancelHold();screen.cancelScrub();}visible=false;if(service()!=null)service().visibility(false,isInPictureInPictureMode());super.onPause();}
    private void closePlayback(){preserve=false;stopService(new Intent(this,PlaybackService.class));finish();}
    @Override public void onDestroy(){destroyed=true;handler.removeCallbacks(tick);for(Dialog d:new ArrayList<>(dialogs))d.dismiss();try{unregisterReceiver(changed);}catch(IllegalArgumentException ignored){}if(isFinishing()&&!preserve)stopService(new Intent(this,PlaybackService.class));super.onDestroy();}
    private void attach(Surface surface){PlaybackService s=service();if(s==null)return;if(surfaceService!=null&&boundSurface!=null&&surfaceService!=s)surfaceService.clearSurface(boundSurface);surfaceService=s;boundSurface=surface;s.setSurface(surface);}
    public void surfaceCreated(SurfaceHolder holder){attach(holder.getSurface());}
    public void surfaceChanged(SurfaceHolder holder,int format,int w,int height){attach(holder.getSurface());}
    public void surfaceDestroyed(SurfaceHolder holder){if(surfaceService!=null&&boundSurface!=null)surfaceService.clearSurface(boundSurface);surfaceService=null;boundSurface=null;}
}
