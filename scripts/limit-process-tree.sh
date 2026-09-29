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
  my $timed_out = 0;
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
