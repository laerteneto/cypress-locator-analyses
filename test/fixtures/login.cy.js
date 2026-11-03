import loginPage from './pages/login.page';

describe('JS page object', () => {
  it('logs in', () => {
    loginPage.typeEmail('ana@example.com');
    loginPage.submit();
  });
});
