package com.suiren.mirea.playback;

/** Matches the server's finite upload ceiling; decoding and IO remain chunked. */
public final class PlaybackLimits {
    private PlaybackLimits(){}
    public static final long MAX_ASSET_BYTES=1L<<40;
}
