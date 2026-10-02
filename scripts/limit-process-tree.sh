#!/bin/sh
# limit-process-tree.sh SECONDS COMMAND [ARGS...]
# OMP and its tool descendants run in their own session; timeout signals the group.
set -eu
[ "$#" -ge 2 ] || { echo 'limit-process-tree: expected SECONDS COMMAND [ARGS...]' >&2; exit 2; }
exec /usr/bin/perl -MPOSIX=setsid -MErrno=EINTR -e '
  my $seconds = shift @ARGV;
  if ($seconds !~ /^[0-9]+$/ || $seconds < 1 || $seconds > 3600) {
    print STDERR "limit-process-tree: invalid bounded timeout\n"; exit 2;
  }
  my $child = fork();
  defined $child or die "limit-process-tree: fork failed: $!\n";
  if ($child == 0) {
    my $session = setsid();
    defined($session) && $session >= 0 or die "limit-process-tree: setsid failed: $!\n";
    exec @ARGV;
    die "limit-process-tree: launch failed: $!\n";
  }
  # The caller can signal only the parent subshell; the session group outlives
  # it. Publish the group id so the caller can signal the group directly.
  if (defined $ENV{LIMIT_PGID_FILE} && length $ENV{LIMIT_PGID_FILE}) {
    open(my $pgid_fh, ">", $ENV{LIMIT_PGID_FILE}) or die "limit-process-tree: cannot write pgid file: $!\n";
    print $pgid_fh "$child\n";
    close($pgid_fh);
  }
  my $timed_out = 0;
  # L2: a TERM/INT to the wrapper must reach the session group. Without this
  # the wrapper died and orphaned the group (e2e-live pid 93914 survived
  # SIGTERM). Forward, reap bounded, and exit with the signal code.
  $SIG{TERM} = $SIG{INT} = sub {
    my $sig = $_[0];
    kill $sig, -$child;
    select undef, undef, undef, 0.5;
    kill "KILL", -$child;
    my $done;
    do { $done = waitpid($child, 0) } while ($done == -1 && $! == EINTR);
    exit $sig eq "TERM" ? 143 : 130;
  };
  $SIG{ALRM} = sub {
    $timed_out = 1;
    kill "TERM", -$child;
    select undef, undef, undef, 0.2;
    kill "KILL", -$child;
  };
  alarm($seconds);
  my $done;
  do { $done = waitpid($child, 0) } while ($done == -1 && $! == EINTR);
  my $status = $?;
  alarm(0);
  if ($timed_out) { print STDERR "limit-process-tree: timed out after $seconds seconds\n"; exit 124; }
  if ($done < 0) { print STDERR "limit-process-tree: wait failed: $!\n"; exit 2; }
  if ($status & 127) { exit 128 + ($status & 127); }
  exit $status >> 8;
' "$@"
