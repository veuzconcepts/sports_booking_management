import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../components/PageHeader.jsx';
import { FormField } from '../components/FormField.jsx';
import { AccountSecurityCard } from '../components/AccountSecurityCard.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import api from '../services/apiClient.js';
import { apiErrorMessage } from '../utils/apiError';

export default function ProfilePage() {
  const { t } = useTranslation('users');
  const { user } = useAuth();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    defaultValues: {
      first_name: user?.first_name || '',
      last_name:  user?.last_name  || '',
      phone:      user?.phone      || '',
    },
  });

  async function onSubmit(values) {
    try {
      await api.patch('/auth/me/', values);
      toast.success(t('profileUpdated'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableSaveYourChangesPlease')));
    }
  }

  return (
    <>
      <PageHeader
        title={t('myProfile')}
        subtitle={t('updateYourNameContactDetails')}
      />

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="card-body">
          <form onSubmit={handleSubmit(onSubmit)}>
            <div className="row">
              <div className="col">
                <FormField label={t('firstName')} error={errors.first_name?.message}>
                  <input
                    className="form-input"
                    {...register('first_name', { required: 'Required' })}
                  />
                </FormField>
              </div>
              <div className="col">
                <FormField label={t('lastName')} error={errors.last_name?.message}>
                  <input
                    className="form-input"
                    {...register('last_name', { required: 'Required' })}
                  />
                </FormField>
              </div>
            </div>

            <FormField label={t('common:labels.email')}>
              <input className="form-input" value={user?.email || ''} disabled />
            </FormField>

            <FormField label={t('common:labels.phone')}>
              <input className="form-input" {...register('phone')} />
            </FormField>

            <FormField label={t('role')}>
              <input
                className="form-input"
                value={(user?.role || '').replace('_', ' ')}
                disabled
              />
            </FormField>

            <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? t('common:state.saving') : t('common:actions.saveChanges')}
            </button>
          </form>
        </div>
      </div>

      <div style={{ height: 20 }} />
      <div style={{ maxWidth: 640 }}>
        <AccountSecurityCard />
      </div>
    </>
  );
}
