import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';

import { PageHeader } from '../components/PageHeader.jsx';
import { FormField } from '../components/FormField.jsx';
import { AccountSecurityCard } from '../components/AccountSecurityCard.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import api from '../services/apiClient.js';
import { apiErrorMessage } from '../utils/apiError';

export default function ProfilePage() {
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
      toast.success('Profile updated');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to save your changes. Please try again.'));
    }
  }

  return (
    <>
      <PageHeader
        title="My profile"
        subtitle="Update your name, contact details, and password."
      />

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="card-body">
          <form onSubmit={handleSubmit(onSubmit)}>
            <div className="row">
              <div className="col">
                <FormField label="First name" error={errors.first_name?.message}>
                  <input
                    className="form-input"
                    {...register('first_name', { required: 'Required' })}
                  />
                </FormField>
              </div>
              <div className="col">
                <FormField label="Last name" error={errors.last_name?.message}>
                  <input
                    className="form-input"
                    {...register('last_name', { required: 'Required' })}
                  />
                </FormField>
              </div>
            </div>

            <FormField label="Email">
              <input className="form-input" value={user?.email || ''} disabled />
            </FormField>

            <FormField label="Phone">
              <input className="form-input" {...register('phone')} />
            </FormField>

            <FormField label="Role">
              <input
                className="form-input"
                value={(user?.role || '').replace('_', ' ')}
                disabled
              />
            </FormField>

            <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save changes'}
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
