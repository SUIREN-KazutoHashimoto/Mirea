package com.suiren.mirea.playback;
import android.content.Context;
import android.graphics.*;
import android.view.*;
import android.widget.*;
import org.json.*;

/** Seek images are held in memory only, not written as decrypted cache files. */
final class VideoSeekView extends LinearLayout {
    interface Commit {void finish(boolean commit,long position);}
    private JSONObject sheet;private Bitmap bitmap;private final TextView label;private final Frame frame;private final HorizontalScrollView scroll;private final LinearLayout strip,buttons;private final Commit commit;
    boolean precise;long selected;
    VideoSeekView(Context context,Commit commit){super(context);this.commit=commit;setOrientation(VERTICAL);setPadding(dp(8),dp(8),dp(8),dp(8));setGravity(Gravity.CENTER_HORIZONTAL);setBackgroundColor(0xf0152038);setTag("seek-preview");label=new TextView(context);label.setTextColor(Color.WHITE);label.setGravity(Gravity.CENTER);addView(label,new LayoutParams(-1,-2));frame=new Frame(context);addView(frame,new LayoutParams(dp(160),dp(90)));scroll=new HorizontalScrollView(context);strip=new LinearLayout(context);scroll.addView(strip);addView(scroll,new LayoutParams(-1,dp(120)));buttons=new LinearLayout(context);for(boolean yes:new boolean[]{true,false}){Button b=new Button(context);b.setText(yes?"ここから再生":"キャンセル");b.setContentDescription(b.getText());b.setOnClickListener(v->commit.finish(yes,selected));buttons.addView(b,new LayoutParams(0,dp(48),1));}addView(buttons,new LayoutParams(-1,dp(48)));setVisibility(GONE);}
    private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    void data(JSONObject nav,Bitmap image){sheet=nav==null?null:nav.optJSONObject("storyboard");bitmap=image;}
    boolean available(){return sheet!=null&&bitmap!=null;}
    void show(long time,boolean fine){if(!available()){setVisibility(GONE);return;}selected=Math.max(0,time);precise=fine;label.setText(PlaybackPresentation.time(selected)+(fine?" · 場面を選択して確定":" · 上へスワイプで精密シーク"));frame.at=time;frame.invalidate();frame.setVisibility(fine?GONE:VISIBLE);scroll.setVisibility(fine?VISIBLE:GONE);buttons.setVisibility(fine?VISIBLE:GONE);setVisibility(VISIBLE);if(fine&&strip.getChildCount()==0){int count=sheet.optInt("count");long interval=(long)sheet.optDouble("intervalMs");for(int n=0;n<count;n++){final long target=n*interval;LinearLayout cell=new LinearLayout(getContext());cell.setOrientation(VERTICAL);cell.setPadding(dp(4),dp(4),dp(4),dp(4));Frame scene=new Frame(getContext());scene.at=target;cell.addView(scene,new LayoutParams(dp(160),dp(90)));TextView title=new TextView(getContext());title.setText(PlaybackPresentation.time(target));title.setTextColor(Color.WHITE);cell.addView(title);cell.setFocusable(true);cell.setContentDescription("再生位置 "+title.getText());cell.setOnClickListener(v->{selected=target;label.setText(PlaybackPresentation.time(target)+" · 確定またはキャンセル");});strip.addView(cell,new LayoutParams(dp(168),dp(120)));}scroll.post(()->scroll.smoothScrollTo((int)(selected/Math.max(1,interval))*dp(168),0));}}
    void hide(){precise=false;setVisibility(GONE);strip.removeAllViews();}
    private final class Frame extends View {long at;final Paint paint=new Paint(Paint.FILTER_BITMAP_FLAG);Frame(Context c){super(c);setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);}protected void onDraw(Canvas canvas){if(!available())return;int count=sheet.optInt("count",1),columns=Math.max(1,sheet.optInt("columns",1)),i=(int)Math.min(count-1,Math.max(0,at/Math.max(1,sheet.optDouble("intervalMs",1)))),w=sheet.optInt("width",160),h=sheet.optInt("height",90);Rect source=new Rect(i%columns*w,i/columns*h,i%columns*w+w,i/columns*h+h);canvas.drawBitmap(bitmap,source,new Rect(0,0,getWidth(),getHeight()),paint);}}
}
