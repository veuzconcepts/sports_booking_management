/**
 * English resources, the source language.
 *
 * English is bundled eagerly because it is the fallback for every missing key
 * in every other language, so it must always be loaded. Other languages are
 * fetched on demand (see `loadLanguage`).
 */
import auditlogs from './auditlogs.json';
import auth from './auth.json';
import bookings from './bookings.json';
import clubs from './clubs.json';
import common from './common.json';
import customers from './customers.json';
import dashboard from './dashboard.json';
import facilities from './facilities.json';
import loyalty from './loyalty.json';
import navigation from './navigation.json';
import notifications from './notifications.json';
import organization from './organization.json';
import payments from './payments.json';
import promotions from './promotions.json';
import reports from './reports.json';
import roles from './roles.json';
import schedule from './schedule.json';
import settings from './settings.json';
import staff from './staff.json';
import subscriptions from './subscriptions.json';
import table from './table.json';
import users from './users.json';
import validation from './validation.json';
import website from './website.json';

export default {
  auditlogs,
  auth,
  bookings,
  clubs,
  common,
  customers,
  dashboard,
  facilities,
  loyalty,
  navigation,
  notifications,
  organization,
  payments,
  promotions,
  reports,
  roles,
  schedule,
  settings,
  staff,
  subscriptions,
  table,
  users,
  validation,
  website,
};
