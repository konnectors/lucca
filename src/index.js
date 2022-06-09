const { CookieKonnector, log, errors, mkdirp } = require('cozy-konnector-libs')
const moment = require('moment')
moment.locale('fr')

const baseStartUrl = 'https://www.lucca.fr'
let companyInstanceUrl
let userLogin
let destinationFolder

class LuccaConnector extends CookieKonnector {
  async fetch(fields) {
    await this.checkLoginInfos(fields)
    await this.resetSession()
    if (!(await this.testSession())) {
      await this.logIn(fields)
    }
    const payslips = await this.getPayslips(fields)

    // Some companies activate 2FA 6 digits to download files, not implemented
    // We test it here
    if (payslips.length > 0) {
      try {
        await this.request(payslips[0].fileurl)
      } catch (e) {
        if (
          e.statusCode === 400 &&
          e.message.includes('6 digit security code has been activated')
        ) {
          log('error', e)
          log('error', 'Not implemented in konnector')
          throw 'USER_ACTION_NEEDED.TWOFA_NEEDED'
        } else {
          throw e
        }
      }
    }
    await this.saveFiles(payslips, { folderPath: destinationFolder })
  }

  async checkLoginInfos(fields) {
    log('info', 'Check if loginUrl exists on fields')

    if (
      Object.prototype.hasOwnProperty.call(fields, 'loginUrl') &&
      fields.loginUrl
    ) {
      log(
        'info',
        'loginUrl exists, so use it and skip fetching company details'
      )
      companyInstanceUrl = fields.loginUrl
      userLogin = fields.login
    } else {
      log(
        'info',
        "loginUrl doesn't exists, log in to get user company details..."
      )
      try {
        const details = await this.request({
          uri: baseStartUrl + '/login/ws-auth-service/wsauth.service.php',
          method: 'POST',
          form: {
            mail: fields.login,
            password: fields.password,
            request: 'emailpass'
          }
        })
        companyInstanceUrl = details.data.user.instance.href
        userLogin = details.data.user.login
      } catch (err) {
        if (
          err.statusCode === 404 &&
          err.error.message &&
          err.error.message.includes('Wrong password')
        ) {
          throw new Error(errors.LOGIN_FAILED)
        } else {
          log('error', JSON.stringify(err.error))
          throw new Error(errors.VENDOR_DOWN)
        }
      }
    }
  }

  async testSession() {
    try {
      log('info', 'Testing session')
      await this.request({
        uri: companyInstanceUrl + '/api/v3/users/me?fields=id',
        method: 'GET'
      })
      log('info', 'Session is OK')
      return true
    } catch (err) {
      log('debug', err.message)
      log('debug', 'Session failed')
      return false
    }
  }

  async logIn(fields) {
    log('info', 'Fetch RequestVerificationToken')
    let RequestVerificationToken = ''
    try {
      const loginPage = await this.request({
        uri: companyInstanceUrl + '/login',
        method: 'GET'
      })
      RequestVerificationToken = loginPage.match(
        '\\<input name\\=\\"__RequestVerificationToken\\" type\\=\\"hidden\\" value=\\"(.*)\\" /\\><input'
      )[1]
    } catch (err) {
      throw new Error('RequestVerificationTokenError')
    }

    log('info', 'Log in with company URL')
    try {
      await this.request({
        uri: companyInstanceUrl + '/identity/login',
        method: 'POST',
        form: {
          UserName: userLogin,
          Password: fields.password,
          __RequestVerificationToken: RequestVerificationToken,
          IsPersistent: [true, false]
        }
      })
    } catch (err) {
      if (
        err.statusCode === 400 &&
        err.error &&
        err.error.includes('Vos identifiants sont erron&#233;s')
      ) {
        throw new Error(errors.LOGIN_FAILED)
      }
    }
  }

  async getPayslips(fields) {
    log('info', 'Get Pagga user details')
    const userDetails = await this.request({
      uri: companyInstanceUrl + '/api/v3/users/me?fields=id,legalEntity',
      method: 'GET'
    })
    const paggaUserId = userDetails.data.id
    destinationFolder =
      fields.folderPath + '/' + userDetails.data.legalEntity.name
    await mkdirp(destinationFolder)

    log('info', 'Get Payslips')
    const payslipsInfos = await this.request({
      uri:
        companyInstanceUrl +
        '/api/v3/payslips?fields=id,import[endDate]&orderby=import.endDate,desc,import.startDate,desc,import.creationDate,desc&ownerID=' +
        paggaUserId,
      method: 'GET'
    })

    return payslipsInfos.data.items.map(function (payslip) {
      const url = companyInstanceUrl + '/pagga/services/download/' + payslip.id
      const date = moment(payslip.import.endDate, moment.ISO_8601)
      const filename = date.format('YYYY_MM') + '.pdf'

      return {
        requestOptions: {
          json: false
        },
        fileurl: url,
        filename
      }
    })
  }
}

// most of the request are done to the API
const connector = new LuccaConnector({
  // debug: true,
  cheerio: false,
  debug: false,
  json: true,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:65.0) Gecko/20100101 Firefox/65.0',
    'Accept-Language': 'fr'
  }
})

connector.run()
