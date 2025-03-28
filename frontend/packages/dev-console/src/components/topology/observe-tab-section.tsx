import { GraphElement } from '@patternfly/react-topology';
import { DetailsTabSectionExtensionHook } from '@console/dynamic-plugin-sdk/src/extensions/topology-details';
import {
  DaemonSetModel,
  DeploymentConfigModel,
  DeploymentModel,
  StatefulSetModel,
} from '@console/internal/models';
import { getResource } from '@console/topology/src/utils';
import MonitoringTab from '../monitoring/overview/MonitoringTab';

export const useObserveSideBarTabSection: DetailsTabSectionExtensionHook = (
  element: GraphElement,
) => {
  const resource = getResource(element);
  if (
    !resource ||
    ![
      DeploymentConfigModel.kind,
      DeploymentModel.kind,
      StatefulSetModel.kind,
      DaemonSetModel.kind,
    ].includes(resource.kind)
  ) {
    return [undefined, true, undefined];
  }
  const { resources } = element.getData();
  const section = resources ? <MonitoringTab item={resources} /> : undefined;
  return [section, true, undefined];
};
