import { connect } from 'react-redux';
import {
  K8sKind,
  K8sResourceKindReference,
  GroupVersionKind,
  isGroupVersionKind,
  allModels,
  getGroupVersionKind,
} from './module/k8s';
import { RootState } from './redux';
import { getK8sModel } from '@console/dynamic-plugin-sdk/src/utils/k8s/hooks/useK8sModel';

export const connectToModel = connect(
  ({ k8s }: RootState, props: { kind: K8sResourceKindReference } & any) => {
    const kind: string = props.kind || props.match?.params?.plural || props.params?.plural;
    return {
      kindObj: getK8sModel(k8s, kind),
      kindsInFlight: k8s.getIn(['RESOURCES', 'inFlight']),
    } as any;
  },
);

/**
 * @deprecated TODO(alecmerdler): `plural` is not a unique lookup key, remove uses of this.
 * FIXME(alecmerdler): Not returning correctly typed `WrappedComponent`
 */
export const connectToPlural = connect(
  (
    { k8s }: RootState,
    props: {
      plural?: GroupVersionKind | string;
      match?: any;
      params?: any;
    },
  ) => {
    const plural = props.plural || props.params?.plural || props.match?.params?.plural;
    const groupVersionKind = getGroupVersionKind(plural);

    let kindObj: K8sKind = null;
    if (groupVersionKind) {
      const [group, version, kind] = groupVersionKind;
      kindObj = allModels().find(
        (model) =>
          (model.apiGroup ?? 'core') === group &&
          model.apiVersion === version &&
          model.kind === kind,
      );

      if (!kindObj) {
        kindObj = getK8sModel(k8s, plural);
      }
    } else {
      kindObj = allModels().find(
        (model) => model.plural === plural && (!model.crd || model.legacyPluralURL),
      );
    }

    const modelRef = isGroupVersionKind(plural) ? plural : kindObj?.kind;

    return { kindObj, modelRef, kindsInFlight: k8s.getIn(['RESOURCES', 'inFlight']) };
  },
);
