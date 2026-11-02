package com.suiren.mirea.playback;

/** Monotonic backoff. A failed reachability check never blocks local playback. */
final class PlaybackRetry {
    private long next;private int failures;
    synchronized boolean ready(long now){return now>=next;}
    synchronized void unavailable(long now){next=now+Math.min(60000,5000L<<Math.min(failures++,4));}
    synchronized void connected(){next=0;failures=0;}
}
