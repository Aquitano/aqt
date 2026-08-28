#!/usr/bin/perl

# Copyright (c) 2025 Jonas van den Berg
# BSD-3-Clause source derived from ejbills/mediaremote-adapter run.pl at
# cf30c4f1af29b5829d859f088f8dbdf12611a046. Kept in the app bundle because
# a link:false Swift-package dependency does not copy its resource bundle.

use strict;
use warnings;
use DynaLoader;

$| = 1;

my $usage = "Usage: $0 <path_to_dylib> <get|loop|play|pause|...>";
die "$usage\n" unless @ARGV >= 2;

my $dylib_path = shift @ARGV;
my $command = shift @ARGV;

die "Dynamic library not found at $dylib_path\n" unless -f $dylib_path;

my $library = DynaLoader::dl_load_file($dylib_path)
    or die "Can't load '$dylib_path': " . DynaLoader::dl_error() . "\n";

sub install_xsub {
    my ($name) = @_;
    my $symbol = DynaLoader::dl_find_symbol($library, "_" . $name)
        || DynaLoader::dl_find_symbol($library, $name);
    die "Can't find symbol '$name' in '$dylib_path'\n" unless $symbol;
    DynaLoader::dl_install_xsub("main::" . $name, $symbol);
}

for my $name (
    qw(
        bootstrap loop get play pause_command toggle_play_pause next_track
        previous_track stop_command toggle_shuffle toggle_repeat
        start_forward_seek end_forward_seek start_backward_seek
        end_backward_seek go_back_fifteen_seconds skip_fifteen_seconds
        like_track ban_track add_to_wish_list remove_from_wish_list
        set_time_from_env set_shuffle_mode set_repeat_mode
    )
) {
    install_xsub($name);
}

bootstrap();

if ($command eq 'loop') {
    loop();
} elsif ($command eq 'get') {
    get();
} elsif ($command eq 'play') {
    play();
} elsif ($command eq 'pause') {
    pause_command();
} elsif ($command eq 'toggle_play_pause') {
    toggle_play_pause();
} elsif ($command eq 'next_track') {
    next_track();
} elsif ($command eq 'previous_track') {
    previous_track();
} elsif ($command eq 'stop') {
    stop_command();
} elsif ($command eq 'toggle_shuffle') {
    toggle_shuffle();
} elsif ($command eq 'toggle_repeat') {
    toggle_repeat();
} elsif ($command eq 'start_forward_seek') {
    start_forward_seek();
} elsif ($command eq 'end_forward_seek') {
    end_forward_seek();
} elsif ($command eq 'start_backward_seek') {
    start_backward_seek();
} elsif ($command eq 'end_backward_seek') {
    end_backward_seek();
} elsif ($command eq 'go_back_fifteen_seconds') {
    go_back_fifteen_seconds();
} elsif ($command eq 'skip_fifteen_seconds') {
    skip_fifteen_seconds();
} elsif ($command eq 'like_track') {
    like_track();
} elsif ($command eq 'ban_track') {
    ban_track();
} elsif ($command eq 'add_to_wish_list') {
    add_to_wish_list();
} elsif ($command eq 'remove_from_wish_list') {
    remove_from_wish_list();
} elsif ($command eq 'set_time') {
    die "Missing time argument for set_time\n" unless defined $ARGV[0];
    $ENV{'MEDIAREMOTE_SET_TIME'} = $ARGV[0];
    set_time_from_env();
} elsif ($command eq 'set_shuffle_mode') {
    die "Missing mode argument for set_shuffle_mode\n" unless defined $ARGV[0];
    $ENV{'MEDIAREMOTE_SET_SHUFFLE_MODE'} = $ARGV[0];
    set_shuffle_mode();
} elsif ($command eq 'set_repeat_mode') {
    die "Missing mode argument for set_repeat_mode\n" unless defined $ARGV[0];
    $ENV{'MEDIAREMOTE_SET_REPEAT_MODE'} = $ARGV[0];
    set_repeat_mode();
} else {
    die "Unknown command: $command\n";
}

# Let fire-and-forget commands reach mediaremoted before Perl tears down.
if ($command ne 'loop' && $command ne 'get') {
    select(undef, undef, undef, 0.01);
}
