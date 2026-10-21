package com.suiren.mirea.playback;

import android.graphics.*;
import android.graphics.drawable.Drawable;
import java.util.*;

/** Static cover-derived light, sampled once per asset. No continual animation. */
final class AudioBackdrop extends Drawable {
    final int[] colors;private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
    AudioBackdrop(Bitmap image,String seed){colors=palette(image,seed);}
    static int[] palette(Bitmap image,String seed){
        ArrayList<Integer> candidates=new ArrayList<>();Random random=new Random(seed.hashCode());if(image!=null&&!image.isRecycled())for(int i=0;i<96;i++){int color=image.getPixel(random.nextInt(image.getWidth()),random.nextInt(image.getHeight())),r=Color.red(color),g=Color.green(color),b=Color.blue(color),max=Math.max(r,Math.max(g,b)),min=Math.min(r,Math.min(g,b));if(Color.alpha(color)>=180&&max>45&&max-min>25&&(r+g+b)/3<235)candidates.add(color);}
        candidates.sort((a,b)->Integer.compare(chroma(b),chroma(a)));ArrayList<Integer> selected=new ArrayList<>();for(int color:candidates){boolean distinct=true;for(int c:selected)if(distance(c,color)<70)distinct=false;if(distinct)selected.add(color);if(selected.size()==3)break;}
        int[] fallback={0xff4463a3,0xff614b9d,0xff22688b};while(selected.size()<3)selected.add(fallback[selected.size()]);return new int[]{selected.get(0),selected.get(1),selected.get(2)};
    }
    private static int chroma(int c){return Math.max(Color.red(c),Math.max(Color.green(c),Color.blue(c)))-Math.min(Color.red(c),Math.min(Color.green(c),Color.blue(c)));}
    private static double distance(int a,int b){return Math.sqrt(Math.pow(Color.red(a)-Color.red(b),2)+Math.pow(Color.green(a)-Color.green(b),2)+Math.pow(Color.blue(a)-Color.blue(b),2));}
    @Override public void draw(Canvas canvas){Rect bounds=getBounds();float w=bounds.width(),h=bounds.height();if(w<=0||h<=0)return;paint.setShader(new LinearGradient(0,0,w,h,new int[]{0xff23375b,0xff111b31,0xff080e1b},new float[]{0,.5f,1},Shader.TileMode.CLAMP));canvas.drawRect(bounds,paint);float[][] points={{.05f,.18f},{.95f,.48f},{.35f,.95f}};for(int i=0;i<3;i++){int c=colors[i]&0xffffff;paint.setShader(new RadialGradient(w*points[i][0],h*points[i][1],Math.max(w,h)*.7f,new int[]{0x4d000000|c,c},new float[]{0,1},Shader.TileMode.CLAMP));canvas.drawRect(bounds,paint);}paint.setShader(null);}
    @Override public void setAlpha(int alpha){}@Override public void setColorFilter(ColorFilter filter){}@Override public int getOpacity(){return PixelFormat.OPAQUE;}
}
