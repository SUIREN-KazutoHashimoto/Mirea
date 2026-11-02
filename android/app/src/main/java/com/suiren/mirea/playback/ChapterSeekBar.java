package com.suiren.mirea.playback;
import android.content.Context;
import android.graphics.*;
import androidx.appcompat.widget.AppCompatSeekBar;
import org.json.*;
final class ChapterSeekBar extends AppCompatSeekBar {
    private JSONArray chapters;private long duration;private final Paint paint=new Paint();
    ChapterSeekBar(Context c){super(c);paint.setColor(0xff101a2b);float d=getResources().getDisplayMetrics().density;
        android.graphics.drawable.GradientDrawable track=shape(0xff48536a,d,4),buffer=shape(0xff71809e,d,4),played=shape(0xffb3c2ff,d,4);
        android.graphics.drawable.LayerDrawable layers=new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[]{track,new android.graphics.drawable.ClipDrawable(buffer,android.view.Gravity.LEFT,1),new android.graphics.drawable.ClipDrawable(played,android.view.Gravity.LEFT,1)});
        int[] ids={android.R.id.background,android.R.id.secondaryProgress,android.R.id.progress};for(int n=0;n<3;n++){layers.setId(n,ids[n]);layers.setLayerHeight(n,Math.round(4*d));layers.setLayerGravity(n,android.view.Gravity.CENTER_VERTICAL);}setProgressDrawable(layers);setThumb(shape(0xffb3c2ff,d,14));setThumbOffset(Math.round(7*d));setSplitTrack(false);
    }
    private static android.graphics.drawable.GradientDrawable shape(int color,float d,int size){android.graphics.drawable.GradientDrawable value=new android.graphics.drawable.GradientDrawable();value.setColor(color);value.setCornerRadius(size*d/2);value.setSize(Math.round(size*d),Math.round(size*d));return value;}
    void chapters(JSONObject nav){chapters=nav==null?null:nav.optJSONArray("chapters");duration=nav==null?0:nav.optLong("durationMs");invalidate();}
    @Override protected synchronized void onDraw(Canvas canvas){super.onDraw(canvas);if(chapters==null||duration<=0)return;int width=getWidth()-getPaddingLeft()-getPaddingRight();for(int n=1;n<chapters.length();n++){JSONObject c=chapters.optJSONObject(n);if(c==null)continue;float x=getPaddingLeft()+width*c.optLong("startMs")/(float)duration;canvas.drawRect(x-1,getHeight()/2f-3,x+1,getHeight()/2f+3,paint);}}
}
