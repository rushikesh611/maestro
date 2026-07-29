---
name: k8s-troubleshooting
description: Kubernetes pod and service debugging workflows
tags: [kubernetes, debugging, production]
---

# Kubernetes Troubleshooting

## Pod Crash Loop
1. `kubectl describe pod &lt;name&gt;` — check Events, Last State, Exit Code
2. `kubectl logs &lt;name&gt; --previous` — capture crash output
3. Check resource limits: `kubectl top pod &lt;name&gt;`
4. Verify image pull secrets and registry access

## Service Unavailable
1. `kubectl get endpoints &lt;svc&gt;` — verify backend pods are registered
2. Check selector labels: `kubectl get svc &lt;svc&gt; -o yaml | grep selector`
3. Verify NetworkPolicies are not blocking traffic
4. Check DNS: `nslookup &lt;svc&gt;.&lt;namespace&gt;.svc.cluster.local`

## High Memory/CPU
1. `kubectl top pod` — identify resource hogs
2. Check HPA status: `kubectl get hpa`
3. Review resource quotas: `kubectl describe resourcequota`