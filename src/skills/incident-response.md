---
name: incident-response
description: Structured incident management and RCA
tags: [incident, management, rca, postmortem]
---

# Incident Response

## Phase 1: Detect
- Confirm scope: services, regions, users affected
- Check alerting sources: PagerDuty, Datadog, Prometheus alerts
- Establish timeline of first error vs first alert

## Phase 2: Triage
- Assess severity: SEV1 (outage), SEV2 (degraded), SEV3 (minor)
- Identify if rollback is faster than fix-forward
- Communicate in incident channel

## Phase 3: Mitigate
- Apply fastest safe fix (restart, scale up, feature flag off, rollback)
- Verify recovery with health checks and metrics
- Do NOT root-cause during mitigation

## Phase 4: Verify
- Monitor error rates, latency, throughput for 5-15 minutes
- Check dependent services recovered

## Phase 5: Postmortem
- Timeline of detection → mitigation → resolution
- Root cause: 5 Whys or fault tree
- Action items: preventive, detective, responsive