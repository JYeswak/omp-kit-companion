# Round 0 predictions (fixture)

ROUND: 0
AUTHOR: FixtureChief

PREDICTION P1: sort outcomes: reclaimed 45%, closed 20%, review-queue 15%, blocked 15%, active 5% (each ±10 points)
PREDICTION P2: at least 80% of in_progress beads have no live seat
PREDICTION P3: at most 1 project misses the insight deadline
PREDICTION P4: jev ready count before sorting is 0
PREDICTION P5: the advisor director scores lower error than the median director
PREDICTION P6: a prediction nobody measured

```json
{
  "schema": "fleet-round.predictions/v1",
  "round": 0,
  "author": "FixtureChief",
  "predictions": [
    {"id": "P1", "metric": "sort_outcome_share", "expect": {"reclaimed": 0.45, "closed": 0.20, "review_queue": 0.15, "blocked": 0.15, "active": 0.05}, "tolerance": 0.10},
    {"id": "P2", "metric": "in_progress_assignee_without_live_seat_share", "expect_min": 0.80},
    {"id": "P3", "metric": "projects_missing_insight_deadline", "expect_max": 1},
    {"id": "P4", "metric": "jev_ready_before_sort", "expect": 0},
    {"id": "P5", "metric": "advisor_director_prediction_error_vs_median", "expect": "lower"},
    {"id": "P6", "metric": "never_measured", "expect_min": 1}
  ]
}
```
