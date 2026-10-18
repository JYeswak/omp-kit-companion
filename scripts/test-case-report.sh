#!/bin/sh
# Optional source-owned case outcomes. awk is already required by the native ladder.
# No arbitrary child log is interpreted as a test result.
start_case_report() {
 [ -n "${OMP_KIT_TEST_CASE_REPORT-}${OMP_KIT_TEST_CASE_SCOPE-}" ] || return 0
 case "${OMP_KIT_TEST_CASE_REPORT-}" in /*) ;; *) return 2 ;; esac
 case "${OMP_KIT_TEST_CASE_SCOPE-}" in
  harness-gate|harness-selftest|claim-selftest|cli-crosscheck|metamorphic-ratchet|readiness-selftest|e2e-live|e2e-plant) ;;
  *) return 2 ;;
 esac
 omp_kit_case_report_failed=0
 omp_kit_case_report_started=0
 omp_kit_case_report_attempts=0
 if (umask 077; set -C; printf '{"schema_version":1,"scope":"%s","event":"begin"}\n' "$OMP_KIT_TEST_CASE_SCOPE" > "$OMP_KIT_TEST_CASE_REPORT"); then
  omp_kit_case_report_started=1
 else
  omp_kit_case_report_failed=1
 fi
 return 0
}
report_test_case() {
 [ -n "${OMP_KIT_TEST_CASE_REPORT-}${OMP_KIT_TEST_CASE_SCOPE-}" ] || return 0
 if [ "${omp_kit_case_report_failed:-0}" -ne 0 ] || [ "${omp_kit_case_report_started:-0}" -ne 1 ]; then return 0; fi
 if [ "$#" -ne 2 ] || [ -z "$1" ]; then omp_kit_case_report_failed=1; return 0; fi
 case "$2" in PASS|FAIL|SKIP) ;; *) omp_kit_case_report_failed=1; return 0 ;; esac
 omp_kit_case_report_attempts=$((omp_kit_case_report_attempts + 1))
 # ENVIRON preserves names literally; awk -v would reinterpret backslash escapes.
 if OMP_KIT_REPORT_NAME="$1" OMP_KIT_REPORT_OUTCOME="$2" awk '
 BEGIN {
  for (i=0; i<32; i++) escaped[sprintf("%c",i)]=sprintf("\\u%04x",i)
  escaped[sprintf("%c",8)]="\\b"; escaped[sprintf("%c",9)]="\\t"
  escaped[sprintf("%c",10)]="\\n"; escaped[sprintf("%c",12)]="\\f"; escaped[sprintf("%c",13)]="\\r"
  escaped["\\"]="\\\\"; escaped["\""]="\\\""
  printf "{\"schema_version\":1,\"scope\":\"%s\",\"event\":\"case\",\"name\":\"", ENVIRON["OMP_KIT_TEST_CASE_SCOPE"]
  name=ENVIRON["OMP_KIT_REPORT_NAME"]
  for(i=1;i<=length(name);i++) { c=substr(name,i,1); printf "%s", (c in escaped ? escaped[c] : c) }
  printf "\",\"outcome\":\"%s\"}\n", ENVIRON["OMP_KIT_REPORT_OUTCOME"]
 }' >> "$OMP_KIT_TEST_CASE_REPORT"; then
  :
 else
  omp_kit_case_report_failed=1
 fi
 return 0
}
finish_case_report() {
 [ -n "${OMP_KIT_TEST_CASE_REPORT-}${OMP_KIT_TEST_CASE_SCOPE-}" ] || return 0
 [ "${omp_kit_case_report_failed:-0}" -eq 0 ] && [ "${omp_kit_case_report_started:-0}" -eq 1 ] || return 0
 if ! printf '{"schema_version":1,"scope":"%s","event":"end","cases":%s}\n' "$OMP_KIT_TEST_CASE_SCOPE" "$omp_kit_case_report_attempts" >> "$OMP_KIT_TEST_CASE_REPORT"; then
  omp_kit_case_report_failed=1
 fi
 return 0
}
