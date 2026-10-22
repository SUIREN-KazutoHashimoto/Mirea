package com.suiren.mirea.playback;

/** Pure presentation policy: rotation never reopens media, and chrome never hides from assistive exploration. */
public final class PlaybackPresentation {
    private PlaybackPresentation() {}
    public static int[] fit(int width,int height,int mediaWidth,int mediaHeight){
        if(width<=0||height<=0)return new int[]{1,1};
        if(mediaWidth<=0||mediaHeight<=0)return new int[]{width,height};
        double scale=Math.min(width/(double)mediaWidth,height/(double)mediaHeight);
        return new int[]{Math.max(1,(int)Math.round(mediaWidth*scale)),Math.max(1,(int)Math.round(mediaHeight*scale))};
    }
    public static String time(long milliseconds){long s=Math.max(0,milliseconds)/1000;return s>=3600?String.format(java.util.Locale.ROOT,"%d:%02d:%02d",s/3600,s/60%60,s%60):String.format(java.util.Locale.ROOT,"%d:%02d",s/60,s%60);}
    public static final class Chrome {
        public static final long HIDE_AFTER_MS=3500;
        private long touched;
        private boolean shown=true,allowed;
        public void interact(long now){shown=true;touched=now;}
        public void toggle(long now){shown=!shown;touched=now;}
        public boolean update(long now,boolean video,boolean playing,boolean busy,boolean accessibility,boolean pip){
            boolean next=video&&playing&&!busy&&!accessibility&&!pip;
            if(!next||!allowed){shown=true;touched=now;}
            allowed=next;
            if(next&&now-touched>=HIDE_AFTER_MS)shown=false;
            return !pip&&(!video||shown);
        }
    }
    public static final class Orientation {
        public static final int AUTOMATIC=0,PORTRAIT=1,LANDSCAPE=2;
        private int manual;
        public Orientation(int manual){this.manual=manual>=0&&manual<=2?manual:0;}
        public int manual(){return manual;}
        public int toggle(boolean landscape){manual=landscape?PORTRAIT:LANDSCAPE;return manual;}
        public int target(boolean video,boolean prepared,int width,int height){
            if(!video)return AUTOMATIC;if(manual!=AUTOMATIC)return manual;
            return !prepared||width<=0||height<=0?AUTOMATIC:width>=height?LANDSCAPE:PORTRAIT;
        }
    }
}
