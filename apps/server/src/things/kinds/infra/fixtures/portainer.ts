/**
 * Answers of Portainer CE 2.45.2 (a throwaway container, 2026-10-21): status, version, environments (2: an Edge agent
 * that never checked in; 3: a Docker API, up, then down with its last snapshot kept), stacks (none), and a Docker
 * environment’s containers through Portainer’s proxy (Docker 29.9.1’s shape, `Health` and Portainer’s `IsPortainer`
 * included), trimmed to the fields read; names, Compose labels, one health and two status words edited for the tests.
 * `image_status` answers 404 in this edition.
 */

export const PORTAINER_STATUS = { Version: '2.45.2', InstanceID: '7fedffb6-ca36-4ee0-9af7-60cfb003719d' };

export const PORTAINER_VERSION = {
  UpdateAvailable: false,
  LatestVersion: '',
  ServerVersion: '2.45.2',
  VersionSupport: 'LTS',
  ServerEdition: 'CE',
  DatabaseVersion: '2.45.2',
  Build: {
    BuildNumber: '40',
    ImageTag: '2.45.2-linux-amd64',
    NodejsVersion: 'v22.23.3',
    PnpmVersion: '10.27.0',
    WebpackVersion: '5.107.2',
    GoVersion: 'go1.26.6',
    GitCommit: '92639f8',
  },
  Dependencies: {
    DockerVersion: 'v28.5.2+incompatible',
    HelmVersion: 'v4.1.4',
    KubectlVersion: 'v1.35.1',
    ComposeVersion: 'v2.40.3',
  },
};

export const PORTAINER_ENDPOINTS = [
  {
    Id: 2,
    Name: 'office',
    Type: 7,
    ContainerEngine: '',
    URL: '127.0.0.1',
    GroupId: 1,
    Status: 1,
    EdgeCheckinInterval: 5,
    LastCheckInDate: 0,
    Heartbeat: false,
    Snapshots: [],
  },
  {
    Id: 3,
    Name: 'office-docker',
    Type: 1,
    ContainerEngine: '',
    URL: 'tcp://172.22.0.5:2375',
    GroupId: 1,
    Status: 1,
    EdgeCheckinInterval: 5,
    LastCheckInDate: 0,
    Heartbeat: false,
    Snapshots: [
      {
        Time: 1792611819,
        DockerVersion: '28.5.2',
        Swarm: false,
        TotalCPU: 4,
        TotalMemory: 8000000000,
        ContainerCount: 5,
        RunningContainerCount: 3,
        StoppedContainerCount: 1,
        HealthyContainerCount: 0,
        UnhealthyContainerCount: 0,
        VolumeCount: 0,
        ImageCount: 0,
        ServiceCount: 0,
        StackCount: 0,
        NodeCount: 1,
        GpuUseAll: false,
        IsPodman: false,
      },
    ],
  },
];

export const PORTAINER_ENDPOINTS_DOWN = [
  {
    Id: 2,
    Name: 'office',
    Type: 7,
    ContainerEngine: '',
    URL: '127.0.0.1',
    GroupId: 1,
    Status: 1,
    EdgeCheckinInterval: 5,
    LastCheckInDate: 0,
    Heartbeat: false,
    Snapshots: [],
  },
  {
    Id: 3,
    Name: 'office-docker',
    Type: 1,
    ContainerEngine: '',
    URL: 'tcp://172.22.0.5:2375',
    GroupId: 1,
    Status: 2,
    EdgeCheckinInterval: 5,
    LastCheckInDate: 0,
    Heartbeat: false,
    Snapshots: [
      {
        Time: 1792611819,
        DockerVersion: '28.5.2',
        Swarm: false,
        TotalCPU: 4,
        TotalMemory: 8000000000,
        ContainerCount: 5,
        RunningContainerCount: 3,
        StoppedContainerCount: 1,
        HealthyContainerCount: 0,
        UnhealthyContainerCount: 0,
        VolumeCount: 0,
        ImageCount: 0,
        ServiceCount: 0,
        StackCount: 0,
        NodeCount: 1,
        GpuUseAll: false,
        IsPodman: false,
      },
    ],
  },
];

export const PORTAINER_STACKS = [];

export const PORTAINER_CONTAINERS = [
  {
    Id: '563520a5533dd36b708d9a9a1e1cd30ec57d4bb7fd83a9e1bd76db6e44874a46',
    Names: ['/portainer'],
    Image: 'portainer/portainer-ce:latest',
    ImageID: 'sha256:03f94a406496dc84d37b552795fc424ccad8d0d7200353b6a82915f6e8f73ab0',
    State: 'running',
    Status: 'Up 2 minutes',
    Health: { FailingStreak: 0, Status: 'none' },
    IsPortainer: true,
    Created: 1792611633,
    Labels: {},
  },
  {
    Id: '9f68b8cccdfbd3ca78b8c6093ee4c517e0ab995469b7166fc8f889f87c30a4aa',
    Names: ['/nextcloud-app'],
    Image: 'jc21/nginx-proxy-manager:latest',
    ImageID: 'sha256:4393e642e233e5efd5adeb7f10918d4aaea71c9ed875b94190273fc8e87f9594',
    State: 'running',
    Status: 'Up 2 minutes',
    Health: { FailingStreak: 0, Status: 'none' },
    IsPortainer: null,
    Created: 1792611633,
    Labels: { 'com.docker.compose.project': 'nextcloud', 'com.docker.compose.service': 'app' },
  },
  {
    Id: '60ebbc0aa4eae05ea04f9cef3b3224fa4159015c748af1f84d4909321f79ed5b',
    Names: ['/grafana'],
    Image: 'grafana/grafana:latest',
    ImageID: 'sha256:dbbc38ea21103cefb50396340cd88afec779c7e070b0a7bf5a75b4ce46651d3f',
    State: 'running',
    Status: 'Up 2 hours (unhealthy)',
    Health: { FailingStreak: 4, Status: 'unhealthy' },
    IsPortainer: null,
    Created: 1792611609,
    Labels: { 'com.docker.compose.project': 'monitoring', 'com.docker.compose.service': 'grafana' },
  },
  {
    Id: '2f5333b94c99c132199b0a02dcfed0c152cbd78ae127ebf6c59905a084cd8f4b',
    Names: ['/portainer-old'],
    Image: 'portainer/portainer-ce:latest',
    ImageID: 'sha256:03f94a406496dc84d37b552795fc424ccad8d0d7200353b6a82915f6e8f73ab0',
    State: 'created',
    Status: 'Created',
    Health: { FailingStreak: 0, Status: 'none' },
    IsPortainer: null,
    Created: 1792611600,
    Labels: {},
  },
  {
    Id: '3bee306607e0983533a1e21d049726e1c3bfc8c0aaad3edc853ffaaaab12c76e',
    Names: ['/nextcloud-db'],
    Image: 'jc21/nginx-proxy-manager:latest',
    ImageID: 'sha256:4393e642e233e5efd5adeb7f10918d4aaea71c9ed875b94190273fc8e87f9594',
    State: 'exited',
    Status: 'Exited (1) 2 minutes ago',
    Health: { FailingStreak: 0, Status: 'none' },
    IsPortainer: null,
    Created: 1792611597,
    Labels: { 'com.docker.compose.project': 'nextcloud', 'com.docker.compose.service': 'db' },
  },
];

/**
 * A Docker environment of Portainer CE 2.45.3 (a throwaway container, 2026-11-04) as `/api/endpoints` answers it, its
 * snapshot trimmed to the figures: images, volumes and Compose projects are counted (the environment above had none).
 */
export const PORTAINER_ENDPOINT_COUNTED = {
  Id: 1,
  Name: 'local',
  Type: 1,
  Status: 1,
  Heartbeat: false,
  LastCheckInDate: 0,
  Snapshots: [
    {
      Time: 1793820499,
      DockerVersion: '29.9.2',
      Swarm: false,
      TotalCPU: 64,
      TotalMemory: 201937268736,
      ContainerCount: 30,
      RunningContainerCount: 29,
      StoppedContainerCount: 1,
      HealthyContainerCount: 18,
      UnhealthyContainerCount: 0,
      VolumeCount: 113,
      ImageCount: 94,
      ServiceCount: 0,
      StackCount: 14,
      NodeCount: 1,
      GpuUseAll: false,
      IsPodman: false,
    },
  ],
};
