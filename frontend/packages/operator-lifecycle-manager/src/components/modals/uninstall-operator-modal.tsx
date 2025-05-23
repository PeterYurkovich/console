/* eslint-disable @typescript-eslint/no-use-before-define */
import * as React from 'react';
import { Alert, Progress, ProgressSize, Title } from '@patternfly/react-core';
import * as _ from 'lodash';
import { Trans, useTranslation } from 'react-i18next';
import { k8sGetResource } from '@console/dynamic-plugin-sdk/src/utils/k8s';
import { settleAllPromises } from '@console/dynamic-plugin-sdk/src/utils/promise';
import { getActiveNamespace } from '@console/internal/actions/ui';
import { coFetchJSON } from '@console/internal/co-fetch';
import { Checkbox } from '@console/internal/components/checkbox';
import {
  createModalLauncher,
  ModalTitle,
  ModalBody,
  ModalSubmitFooter,
} from '@console/internal/components/factory/modal';
import {
  history,
  LinkifyExternal,
  ResourceLink,
  resourceListPathFromModel,
  StatusBox,
} from '@console/internal/components/utils';
import { useK8sWatchResource } from '@console/internal/components/utils/k8s-watch-hook';
import { useAccessReview } from '@console/internal/components/utils/rbac';
import { ConsoleOperatorConfigModel } from '@console/internal/models';
import {
  K8sKind,
  K8sResourceCommon,
  K8sResourceKind,
  modelFor,
  referenceFor,
  k8sPatch,
  referenceForModel,
} from '@console/internal/module/k8s';
import { YellowExclamationTriangleIcon } from '@console/shared';
import { CONSOLE_OPERATOR_CONFIG_NAME } from '@console/shared/src/constants';
import { usePromiseHandler } from '@console/shared/src/hooks/promise-handler';
import { useOperands } from '@console/shared/src/hooks/useOperands';
import { getPatchForRemovingPlugins, isPluginEnabled } from '@console/shared/src/utils';
import { DEFAULT_GLOBAL_OPERATOR_INSTALLATION_NAMESPACE } from '../../const';
import { ClusterServiceVersionModel, SubscriptionModel } from '../../models';
import { ClusterServiceVersionKind, SubscriptionKind } from '../../types';
import { OperandLink } from '../operand/operand-link';
import { OLMAnnotation } from '../operator-hub';
import { getClusterServiceVersionPlugins } from '../operator-hub/operator-hub-utils';
import Timeout = NodeJS.Timeout;

const deleteOptions = {
  kind: 'DeleteOptions',
  apiVersion: 'v1',
  propagationPolicy: 'Foreground',
};

export const UninstallOperatorModal: React.FC<UninstallOperatorModalProps> = ({
  cancel,
  close,
  csv,
  k8sKill,
  subscription,
}) => {
  const { t } = useTranslation();
  const [
    handleOperatorUninstallPromise,
    operatorUninstallInProgress,
    operatorUninstallErrorMessage,
  ] = usePromiseHandler();
  const [showInstructions, setShowInstructions] = React.useState(true);
  const [operatorUninstallFinished, setOperatorUninstallFinished] = React.useState(false);
  const [deleteOperands, setDeleteOperands] = React.useState(false);
  const [operandsDeleteInProgress, setOperandsDeleteInProgress] = React.useState(false);
  const [operandsRemaining, setOperandsRemaining] = React.useState(0);
  const [operandsDeleteFinished, setOperandsDeleteFinished] = React.useState(false);
  const [operandDeletionErrors, setOperandDeletionErrors] = React.useState<OperandError[]>([]);
  const [operandDeletionVerificationError, setOperandDeletionVerificationError] = React.useState(
    false,
  );
  const [clusterServiceVersionExistsError, setClusterServiceVersionExistsError] = React.useState(
    '',
  );

  const canPatchConsoleOperatorConfig = useAccessReview({
    group: ConsoleOperatorConfigModel.apiGroup,
    resource: ConsoleOperatorConfigModel.plural,
    verb: 'patch',
    name: CONSOLE_OPERATOR_CONFIG_NAME,
  });

  const csvPlugins = getClusterServiceVersionPlugins(csv?.metadata?.annotations);

  const [consoleOperatorConfig] = useK8sWatchResource<K8sResourceKind>(
    canPatchConsoleOperatorConfig && csvPlugins.length > 0
      ? {
          kind: referenceForModel(ConsoleOperatorConfigModel),
          isList: false,
          name: CONSOLE_OPERATOR_CONFIG_NAME,
        }
      : null,
  );

  const enabledPlugins = csvPlugins.filter((plugin) =>
    isPluginEnabled(consoleOperatorConfig, plugin),
  );

  const removePlugins: boolean =
    !!consoleOperatorConfig && canPatchConsoleOperatorConfig && enabledPlugins.length > 0;

  const subscriptionName = subscription?.spec?.name;
  const subscriptionNamespace = subscription?.metadata?.namespace;

  const isSubmitInProgress = operatorUninstallInProgress || operandsDeleteInProgress;

  const isSubmitFinished =
    !isSubmitInProgress && (!deleteOperands || operandsDeleteFinished) && operatorUninstallFinished;

  const hasSubmitErrors = operandDeletionErrors.length > 0 || operatorUninstallErrorMessage !== '';

  // Skip loading the operands if we are not going to delete them if they opted Out
  const optOutAnnotation = 'console.openshift.io/disable-operand-delete';
  const optedOut = csv?.metadata?.annotations?.[optOutAnnotation] === 'true';

  // TODO: Commenting out for review, wanted to prevent loading the operands if not needed, but lint check throws error
  // const [operands, operandsLoaded, operandsLoadedErrorMessage] = optedOut
  //   ? [[], true, '']
  //   : useOperands(subscriptionName, subscriptionNamespace);
  const [operands, operandsLoaded, operandsLoadedErrorMessage] = useOperands(
    subscriptionName,
    subscriptionNamespace,
  );

  const uninstallOperator = React.useCallback(async () => {
    const patch = removePlugins
      ? getPatchForRemovingPlugins(consoleOperatorConfig, enabledPlugins)
      : null;

    const clusterServiceVersionExists = async () => {
      try {
        await k8sGetResource({
          model: ClusterServiceVersionModel,
          name: subscription.status.installedCSV,
          ns: subscription.metadata.namespace,
        });
        return true;
      } catch (err) {
        if (err.response.status !== 404) {
          setClusterServiceVersionExistsError(err.message);
        }
        return false;
      }
    };

    const operatorUninstallPromises = [
      k8sKill(SubscriptionModel, subscription, {}, deleteOptions),
      ...(subscription?.status?.installedCSV && (await clusterServiceVersionExists())
        ? [
            k8sKill(
              ClusterServiceVersionModel,
              {
                metadata: {
                  name: subscription.status.installedCSV,
                  namespace: subscription.metadata.namespace,
                },
              },
              {},
              deleteOptions,
            ),
          ]
        : []),
      ...(removePlugins
        ? [k8sPatch(ConsoleOperatorConfigModel, consoleOperatorConfig, [patch])]
        : []),
    ];

    handleOperatorUninstallPromise(Promise.all(operatorUninstallPromises))
      .then(() => {
        setOperatorUninstallFinished(true);
      })
      .catch(() => {
        setOperatorUninstallFinished(true);
      });
  }, [
    consoleOperatorConfig,
    enabledPlugins,
    handleOperatorUninstallPromise,
    k8sKill,
    removePlugins,
    subscription,
  ]);

  const finishVerification = React.useCallback(
    (proceedToUninstallOperator: boolean) => {
      setOperandsDeleteInProgress(false);
      setOperandsDeleteFinished(true);
      if (proceedToUninstallOperator) {
        uninstallOperator();
      } else {
        setOperandDeletionVerificationError(true);
        setOperatorUninstallFinished(true);
      }
    },
    [uninstallOperator],
  );

  const pollOperands = React.useCallback((): Timeout => {
    const url = `${window.SERVER_FLAGS.basePath}api/list-operands/?name=${subscriptionName}&namespace=${subscriptionNamespace}`;
    const interval = setInterval(() => {
      coFetchJSON(url)
        .then((curOperands) => {
          setOperandsRemaining(curOperands.items.length);
          if (curOperands.items.length === 0) {
            clearInterval(interval);
            setTimeout(() => finishVerification(true), 1000); // allow '0 Operands remaining' to display for a second
          }
        })
        .catch(() => {
          finishVerification(false);
        });
    }, 2000); // every 2 seconds
    return interval;
  }, [finishVerification, subscriptionName, subscriptionNamespace]);

  const closeAndRedirect = React.useCallback(() => {
    close();
    // if url contains subscription name (ex: "codeready-workspaces") or installedCSV version (ex: "crwoperator.v2.9.0")
    // redirect to ClusterServiceVersion "Installed Operators" list page,
    // else uninstalled from "Installed Operators" list page, so do not redirect
    if (
      window.location.pathname.split('/').includes(subscription.metadata.name) ||
      window.location.pathname.split('/').includes(subscription?.status?.installedCSV)
    ) {
      history.push(resourceListPathFromModel(ClusterServiceVersionModel, getActiveNamespace()));
    }
  }, [close, subscription]);

  React.useEffect(() => {
    if (isSubmitFinished && !hasSubmitErrors) {
      closeAndRedirect();
    }
  }, [closeAndRedirect, hasSubmitErrors, isSubmitFinished]);

  React.useEffect(() => {
    let intervalID;
    if (operandsDeleteInProgress) {
      intervalID = pollOperands();
    }
    return () => {
      if (intervalID) {
        clearInterval(intervalID);
      }
    };
  }, [operandsDeleteInProgress, pollOperands]);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isSubmitFinished) {
      closeAndRedirect();
      return;
    }

    setShowInstructions(false);
    if (deleteOperands) {
      setOperandsDeleteInProgress(true);
      setOperandsRemaining(operands.length);
      const operandDeletionPromises = operands.map((operand: K8sResourceCommon) => {
        const model = modelFor(referenceFor(operand));
        return k8sKill(model, operand, {}, deleteOptions);
      });
      // eslint-disable-next-line promise/catch-or-return
      settleAllPromises(operandDeletionPromises).then(([, , results]) => {
        const operandErrors: OperandError[] = results.reduce((acc: OperandError[], curr, i) => {
          return curr.status === 'rejected'
            ? acc.concat({ operand: operands[i], errorMessage: curr.reason })
            : acc;
        }, []);
        if (operandErrors.length) {
          setOperandDeletionErrors(operandErrors);
          setOperandsDeleteInProgress(false);
          setOperandsDeleteFinished(true);
          setOperatorUninstallFinished(true);
        }
      });
    } else {
      setOperandsDeleteFinished(true);
      uninstallOperator();
    }
  };

  const name = csv?.spec?.displayName || subscription?.spec?.name;
  const csvName = csv?.metadata?.name;
  const namespace =
    subscription.metadata.namespace === DEFAULT_GLOBAL_OPERATOR_INSTALLATION_NAMESPACE
      ? 'all-namespaces'
      : subscription.metadata.namespace;
  const uninstallMessage = csv?.metadata?.annotations?.[OLMAnnotation.UninstallMessage];
  const showOperandsContent = !operandsLoaded || operands.length > 0;

  const instructions = (
    <>
      <p>
        {showOperandsContent && (
          <>
            {' '}
            {t(
              'olm~Select the checkbox below to also remove all Operands associated with this Operator.',
            )}
          </>
        )}{' '}
        {t(
          'olm~If your Operator configured off-cluster resources, these will continue to run and require manual cleanup.',
        )}
      </p>
      {removePlugins && (
        <p>
          {t('olm~The console plugin provided by this operator will be disabled and removed.', {
            count: enabledPlugins.length,
          })}
        </p>
      )}
    </>
  );

  const operandsSection = operandsLoadedErrorMessage ? (
    <OperandsLoadedErrorAlert operandsLoadedErrorMessage={operandsLoadedErrorMessage} />
  ) : (
    showOperandsContent && (
      <>
        <span className="co-operator-uninstall__operands-section">
          <Title headingLevel="h2" className="pf-v6-u-mb-sm">
            {t('olm~Operand instances')}
          </Title>
          <OperandsTable
            operands={operands}
            loaded={operandsLoaded}
            csvName={csvName}
            cancel={cancel} // for breadcrumbs & cancel modal when clicking on operand links
          />
        </span>
        <Checkbox
          onChange={({ currentTarget }) => setDeleteOperands(currentTarget.checked)}
          name="delete-all-operands"
          label={t('olm~Delete all operand instances for this operator')}
          checked={deleteOperands}
        />
      </>
    )
  );

  const operandDeletionAlert = operandDeletionErrors.length ? (
    <OperandDeletionErrorAlert
      operandDeletionErrors={operandDeletionErrors}
      csvName={csvName}
      cancel={cancel}
    />
  ) : operandDeletionVerificationError ? (
    <OperandsLoadedErrorAlert
      operandsLoadedErrorMessage={t('olm~Error listing operand to verify deletion')}
    />
  ) : (
    <OperandDeletionSuccessAlert name={name} namespace={namespace} />
  );

  const results = (
    <>
      <UninstallAlert
        errorMessage={
          clusterServiceVersionExistsError ||
          operatorUninstallErrorMessage ||
          (operandDeletionErrors.length
            ? t('olm~Operator could not be uninstalled due to error deleting its Operands')
            : '')
        }
        name={name}
        namespace={namespace}
      />
      {deleteOperands && operandDeletionAlert}
    </>
  );

  return (
    <form onSubmit={submit} name="form" className="modal-content co-catalog-install-modal">
      <ModalTitle className="modal-header">
        <YellowExclamationTriangleIcon className="co-icon-space-r" /> {t('olm~Uninstall Operator?')}
      </ModalTitle>
      <ModalBody>
        {showInstructions && (
          <>
            <p>
              <Trans t={t} ns="olm">
                Operator <strong>{{ name }}</strong> will be removed from{' '}
                <strong>{{ namespace }}</strong>.
              </Trans>
            </p>
            {!optedOut && <>{instructions}</>}
            {uninstallMessage && (
              <>
                <Title headingLevel="h2" className="pf-v6-u-mb-sm">
                  {t('olm~Message from Operator developer')}
                </Title>
                <p>
                  <LinkifyExternal>{uninstallMessage}</LinkifyExternal>
                </p>
              </>
            )}
            {!optedOut && <>{operandsSection}</>}
          </>
        )}
        {operandsDeleteInProgress && (
          <OperandDeleteProgress total={operands.length} remaining={operandsRemaining} />
        )}
        {operatorUninstallInProgress && (
          <div>
            <p>{t('olm~Uninstalling the Operator...')}</p>
          </div>
        )}
        {isSubmitFinished && results}
      </ModalBody>
      <ModalSubmitFooter
        inProgress={isSubmitInProgress}
        cancel={cancel}
        submitDanger={!isSubmitFinished} // if submit finished show a non-danger 'OK'
        submitText={t(isSubmitFinished ? 'olm~OK' : 'olm~Uninstall')}
        submitDisabled={isSubmitInProgress}
      />
    </form>
  );
};

const OperandDeleteProgress: React.FC<{
  total: number;
  remaining: number;
}> = ({ total, remaining }) => {
  const { t } = useTranslation();
  const progressLabel = t('olm~Remaining Operands: {{remaining}} of {{total}} ', {
    remaining,
    total,
  });
  return (
    <div>
      <Progress
        value={total - remaining}
        max={total}
        valueText={progressLabel}
        label={progressLabel}
        title={t('olm~Cleaning up operand instances...')}
        size={ProgressSize.lg}
      />
      <div className="co-alert--margin-top">
        <p>
          {t(
            'olm~The operands have been marked for deletion and are being removed. Canceling this operation will leave the Operator installed though its operand instances will continue to be deleted.',
          )}
        </p>
      </div>
    </div>
  );
};

const OperandsLoadedErrorAlert: React.FC<{ operandsLoadedErrorMessage: string }> = ({
  operandsLoadedErrorMessage,
}) => {
  const { t } = useTranslation();
  return (
    <Alert variant="warning" className="co-alert" title={t('olm~Cannot load Operands')} isInline>
      <p>
        {t(
          'olm~There was an error loading operands for this operator. Operands will need to be deleted manually.',
        )}
      </p>
      <p>{operandsLoadedErrorMessage}</p>
    </Alert>
  );
};

const OperatorUninstallSuccessAlert: React.FC<{ name: string; namespace: string }> = ({
  name,
  namespace,
}) => {
  const { t } = useTranslation();
  return (
    <Alert
      variant="success"
      className="co-alert"
      title={t('olm~Successfully uninstalled Operator')}
      isInline
    >
      <p>
        <Trans t={t} ns="olm">
          Operator <strong>{{ name }}</strong> successfully uninstalled from{' '}
          <strong>{{ namespace }}</strong>.
        </Trans>
      </p>
    </Alert>
  );
};

const OperatorUninstallErrorAlert: React.FC<{ errorMessage: string }> = ({ errorMessage }) => {
  const { t } = useTranslation();
  return (
    <Alert
      variant="danger"
      className="co-alert"
      title={t('olm~Error uninstalling Operator')}
      isInline
    >
      <p>
        {t('olm~There was an error uninstalling the operator.')}
        <br />
        {errorMessage}
      </p>
    </Alert>
  );
};

const OperandDeletionErrorAlert: React.FC<{
  operandDeletionErrors: OperandError[];
  csvName: string;
  cancel?: () => void;
}> = ({ operandDeletionErrors, csvName, cancel }) => {
  const { t } = useTranslation();
  return (
    <Alert variant="danger" className="co-alert" title={t('olm~Error deleting Operands')} isInline>
      <p>
        {t(
          'olm~There were errors deleting the following Operands, they will need to be deleted manually:',
        )}
      </p>
      <OperandErrorList
        operandErrors={operandDeletionErrors}
        csvName={csvName}
        cancel={cancel} // for breadcrumbs & cancel modal when clicking on operand links
      />
    </Alert>
  );
};

const OperandDeletionSuccessAlert: React.FC<{ name: string; namespace: string }> = ({
  name,
  namespace,
}) => {
  const { t } = useTranslation();
  return (
    <Alert
      variant="success"
      className="co-alert"
      title={t('olm~Successfully deleted all Operand Instances')}
      isInline
    >
      <p>
        <Trans t={t} ns="olm">
          All Operand instances for Operator <strong>{{ name }}</strong> in{' '}
          <strong>{{ namespace }}</strong> have been deleted.
        </Trans>
      </p>
    </Alert>
  );
};

const UninstallAlert: React.FC<{ errorMessage: string; name: string; namespace: string }> = ({
  errorMessage,
  name,
  namespace,
}) =>
  errorMessage ? (
    <OperatorUninstallErrorAlert errorMessage={errorMessage} />
  ) : (
    <OperatorUninstallSuccessAlert name={name} namespace={namespace} />
  );

const OperandsTable: React.FC<OperandsTableProps> = ({ operands, loaded, csvName, cancel }) => {
  const { t } = useTranslation();
  return (
    <StatusBox
      skeleton={<div className="loading-skeleton--table" />}
      data={operands}
      loaded={loaded}
    >
      <table className="pf-v6-c-table pf-m-compact pf-m-border-rows">
        <thead className="pf-v6-c-table__thead">
          <tr className="pf-v6-c-table__tr" key="operand-table-header-row">
            <th className="pf-m-width-35 pf-v6-c-table__th">{t('olm~Name')}</th>
            <th className="pf-v6-c-table__th">{t('olm~Kind')}</th>
            <th className="pf-v6-c-table__th">{t('olm~Namespace')}</th>
          </tr>
        </thead>
        <tbody>
          {operands
            .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
            .map((operand) => (
              <tr className="pf-v6-c-table__tr" key={operand.metadata.uid}>
                <td className="pf-v6-c-table__td">
                  <OperandLink obj={operand} csvName={csvName} onClick={cancel} />
                </td>
                <td
                  className="pf-v6-c-table__td pf-m-break-word"
                  data-test-operand-kind={operand.kind}
                >
                  {operand.kind}
                </td>
                <td className="pf-v6-c-table__td">
                  {operand.metadata.namespace ? (
                    <ResourceLink
                      kind="Namespace"
                      name={operand.metadata.namespace}
                      onClick={cancel}
                    />
                  ) : (
                    '-'
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </StatusBox>
  );
};

const OperandErrorList: React.FC<OperandErrorListProps> = ({ operandErrors, csvName, cancel }) => {
  const { t } = useTranslation();
  return (
    <ul className="co-operator-uninstall-alert__list">
      {_.map(operandErrors, (operandError) => (
        <li
          key={operandError.operand.metadata.uid}
          className="pf-v6-c-list pf-m-plain co-operator-uninstall-alert__list-item"
        >
          <OperandLink obj={operandError.operand} csvName={csvName} onClick={cancel} />{' '}
          {operandError.operand.kind}
          {'  '}
          {t('olm~Error: {{error}}', {
            error: operandError.errorMessage,
          })}
        </li>
      ))}
    </ul>
  );
};

export const createUninstallOperatorModal = createModalLauncher(UninstallOperatorModal);

export type UninstallOperatorModalProps = {
  cancel?: () => void;
  close?: () => void;
  k8sKill: (kind: K8sKind, resource: K8sResourceKind, options: any, json: any) => Promise<any>;
  k8sGet: (kind: K8sKind, name: string, namespace: string) => Promise<K8sResourceKind>;
  k8sPatch: (
    kind: K8sKind,
    resource: K8sResourceKind,
    data: { op: string; path: string; value: any }[],
  ) => Promise<any>;
  subscription: SubscriptionKind | K8sResourceKind;
  csv?: ClusterServiceVersionKind;
  blocking?: boolean;
};

type OperandsTableProps = {
  operands: K8sResourceCommon[];
  loaded: boolean;
  csvName: string;
  cancel?: () => void;
};

type OperandError = { operand: K8sResourceCommon; errorMessage: string };
type OperandErrorListProps = {
  operandErrors?: OperandError[];
  csvName: string;
  cancel?: () => void;
};

UninstallOperatorModal.displayName = 'UninstallOperatorModal';
