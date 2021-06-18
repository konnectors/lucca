const {
  BaseKonnector,
  log,
  requestFactory,
  saveFiles,
  errors
} = require('cozy-konnector-libs')
const request = requestFactory({
  // cheerio: true
  debug: false,
  json: true,
  jar: true
})
const parseISO = require('date-fns/parseISO')
const format = require('date-fns/format')
const cheerio = require('cheerio')

const baseStartUrl = 'https://www.lucca.fr'
let companyInstanceUrl

module.exports = new BaseKonnector(start)
// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  await checkLoginInfos(fields)
  await logIn(fields)
  const payslips = await getPayslips()

  // Some companies activate 2FA 6 digits to download files, not implemented
  // We test it here
  if (payslips.length > 0) {
    try {
      await request(payslips[0].fileurl)
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
  await saveFiles(payslips, fields)
}

async function checkLoginInfos(fields) {
  log('info', 'Check if loginUrl exists on fields')

  if (
    Object.prototype.hasOwnProperty.call(fields, 'loginUrl') &&
    fields.loginUrl
  ) {
    log('info', 'loginUrl exists, so use it and skip fetching company details')
    companyInstanceUrl = fields.loginUrl
  } else {
    log(
      'info',
      "loginUrl doesn't exists, log in to get user company details..."
    )
    try {
      const details = await request({
        uri: baseStartUrl + '/login/ws-auth-service/wsauth.service.php',
        method: 'POST',
        form: {
          mail: fields.login,
          password: fields.password,
          request: 'emailpass'
        }
      })
      companyInstanceUrl = details.data[0]
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

async function logIn(fields) {
  log('info', "Get the verification token hidden in the company's login's form")
  const form = await request({
    uri: companyInstanceUrl + '/identity/login',
    method: 'GET'
  })
  const $ = cheerio.load(form)
  const requestVerificationToken = $(
    'input[name="__RequestVerificationToken"]'
  ).attr('value')

  log('info', 'Log in with company URL')
  try {
    await request({
      uri: companyInstanceUrl + '/identity/login',
      method: 'POST',
      form: {
        UserName: fields.login,
        Password: fields.password,
        IsPersistent: true,
        __RequestVerificationToken: requestVerificationToken
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

async function getPayslips() {
  log('info', 'Get Pagga userId')
  const userDetails = await request({
    uri: companyInstanceUrl + '/api/v3/users/me?fields=id',
    method: 'GET'
  })
  const paggaUserId = userDetails.data.id

  log('info', 'Get Payslips')
  const payslipsInfos = await request({
    uri:
      companyInstanceUrl +
      '/api/v3/payslips?fields=id,import[endDate]&orderby=import.endDate,desc,import.startDate,desc,import.creationDate,desc&ownerID=' +
      paggaUserId,
    method: 'GET'
  })

  return payslipsInfos.data.items.map(function(payslip) {
    const url = companyInstanceUrl + '/pagga/services/download/' + payslip.id
    const date = parseISO(payslip.import.endDate)
    const filename = format(date, 'yyyy_MM') + '.pdf'

    return {
      fileurl: url,
      filename
    }
  })
}
