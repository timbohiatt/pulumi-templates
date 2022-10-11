import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const config = new pulumi.Config();
const containerPort = config.getNumber("containerPort") || 80;
const cpu = config.get("cpu") || "1";
const memory = config.get("memory") || "512Mi";

var dependencies: Array<pulumi.Resource> = []

// List of GCP API's That Need to be enabled on the GCP Project
var gcpServiceAPIs: Array<string> = [
    "run.googleapis.com",
    "compute.googleapis.com",
]

// Description: Enable required API services for a Google Cloud Platform project
// GCP Docs:    https://cloud.google.com/apis/docs/overview
// Pulumi Docs: https://www.pulumi.com/registry/packages/gcp/api-docs/projects/service/
for (var idx in gcpServiceAPIs) {
    dependencies.push(
        // Enable GCP Service API
        new gcp.projects.Service("".concat("gcp-api-", gcpServiceAPIs[idx]), {
            disableDependentServices: true,
            service: gcpServiceAPIs[idx],
        }, {})
    )
}

// Description: Create Cloud Run Container Service & Deploy a Container
// GCP Docs:    https://cloud.google.com/run/docs/overview/what-is-cloud-run
// Pulumi Docs: https://www.pulumi.com/registry/packages/gcp/api-docs/cloudrun/service/
const cloudrunService = new gcp.cloudrun.Service("gcp-cloud-run-service", {
    location: gcp.config.region,
    name: "".concat("cloud-run-svc", "-", gcp.config.region),
    metadata: {
        annotations: {
            "run.googleapis.com/ingress": "internal-and-cloud-load-balancing",
        }
    },
    template: {
        spec: {
            containers: [{
                image: "europe-docker.pkg.dev/cloudrun/container/hello",
                ports: [
                    {
                        containerPort: containerPort,
                    }
                ],
                resources: {
                    requests: {
                        "cpu": cpu,
                        "memory": memory,
                    }
                }
            }],
            containerConcurrency: 50,
        },
    },
}, {
    dependsOn: dependencies,
});

// Description: Get IAM Policy for All Users & Assign Role (run.invoker)
// GCP Docs:    https://cloud.google.com/iam/docs/policies
// Pulumi Docs: https://www.pulumi.com/registry/packages/gcp/api-docs/organizations/getiampolicy/
const noauthIAMPolicy = gcp.organizations.getIAMPolicy({
    bindings: [{
        role: "roles/run.invoker",
        members: ["allUsers"],
    }],
});

// Description: Bind IAM Policy to Cloud Run Service
// GCP Docs:    https://cloud.google.com/run/docs/reference/iam/permissions
// Pulumi Docs: https://www.pulumi.com/registry/packages/gcp/api-docs/cloudrun/iampolicy/
const cloudRunIamPolicy = new gcp.cloudrun.IamPolicy("gcp-cloud-run-noauth-iam-policy", {
    location: cloudrunService.location,
    project: cloudrunService.project,
    service: cloudrunService.name,
    policyData: noauthIAMPolicy.then(noauthIAMPolicy => noauthIAMPolicy.policyData),
}, {});

// Description: Create GCP Serverless Regional Network Endpoint Group (for Cloud Run)
// GCP Docs:    https://cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts
// Pulumi Docs: https://www.pulumi.com/registry/packages/gcp/api-docs/compute/regionnetworkendpointgroup/
const regionNetworkEndpointGroup = new gcp.compute.RegionNetworkEndpointGroup("gcp-regional-sneg-cloud-run", {
    networkEndpointType: "SERVERLESS",
    region: gcp.config.region,
    cloudRun: {
        service: cloudrunService.name,
    },
}, {});

// Description: Create GCP Regional Load Balancer for Cloud Run Network Endpoint Group
// GCP Docs:    https://cloud.google.com/load-balancing/docs/backend-service
// Pulumi Docs: https://www.pulumi.com/registry/packages/gcp/api-docs/compute/backendservice/
const backendService = new gcp.compute.BackendService("gcp-regional-load-balancer", {
    loadBalancingScheme: "EXTERNAL_MANAGED",
    backends: [{
        group: regionNetworkEndpointGroup.selfLink,
        balancingMode: "UTILIZATION",
        capacityScaler: 0.1
    },],
}, {});


// Description: Provision a global external IP address for the GCP Regional Load Balancer.
// GCP Docs:    https://cloud.google.com/compute/docs/ip-addresses
// Pulumi Docs: https://www.pulumi.com/registry/packages/gcp/api-docs/compute/globaladdress/
const ip = new gcp.compute.GlobalAddress("gcp-external-ip-address", {}, { dependsOn: dependencies });

// Descritption Create a GCP URLMap to route requests to the Cloud Run Serverless Backend Service
// GCP Docs:    https://www.pulumi.com/registry/packages/gcp/api-docs/compute/urlmap/
// Pulumi Docs: https://cloud.google.com/load-balancing/docs/url-map-concepts
const urlMapHttp = new gcp.compute.URLMap("gcp-load-balancer-url-map-http", {
    defaultService: backendService.selfLink,
}, {});


// Description: Create a Regional Target HTTP proxy to route requests to the GCP URLMap.
// GCP Docs:    https://cloud.google.com/load-balancing/docs/target-proxies
// Pulumi Docs: https://www.pulumi.com/registry/packages/gcp/api-docs/compute/targethttpproxy/
const httpProxy = new gcp.compute.TargetHttpProxy("gcp-load-balancer-http-proxy", {
    urlMap: urlMapHttp.selfLink,
}, {});

// Description: Create a GlobalForwardingRule rule to route requests to the Target HTTP proxy.
// GCP Docs:    https://cloud.google.com/load-balancing/docs/forwarding-rule-concepts
// Pulumi Docs: https://www.pulumi.com/registry/packages/gcp/api-docs/compute/globalforwardingrule/
const httpForwardingRule = new gcp.compute.GlobalForwardingRule("gcp-load-balancer-http-forwarding-rule", {
    ipAddress: ip.address,
    ipProtocol: "TCP",
    portRange: "80",
    target: httpProxy.selfLink,
    loadBalancingScheme: "EXTERNAL_MANAGED",
}, {});


// The URL at which the Cloud Run container's HTTP endpoint will be available via the External Load Balancer
export const url = pulumi.interpolate`http://${ip.address}/`;