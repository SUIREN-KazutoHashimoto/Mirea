package com.suiren.mirea.playback;
import android.content.Context;
import android.graphics.*;
import android.widget.SeekBar;
import org.json.*;
final class ChapterSeekBar extends androidx.appcompat.widget.AppCompatSeekBar {
    private JSONArray chapters;private long duration;private final Paint paint=new Paint();
    ChapterSeekBar(Context c){super(c);paint.setColor(0xff101a2b);}
    void chapters(JSONObject nav){chapters=nav==null?null:nav.optJSONArray("chapters");duration=nav==null?0:nav.optLong("durationMs");invalidate();}
    @Override protected synchronized void onDraw(Canvas canvas){super.onDraw(canvas);if(chapters==null||duration<=0)return;int width=getWidth()-getPaddingLeft()-getPaddingRight();for(int n=1;n<chapters.length();n++){JSONObject c=chapters.optJSONObject(n);if(c==null)continue;float x=getPaddingLeft()+width*c.optLong("startMs")/(float)duration;canvas.drawRect(x-1,getHeight()/2f-3,x+1,getHeight()/2f+3,paint);}}
}
