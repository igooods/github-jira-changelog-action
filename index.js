const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');
const Entities = require('html-entities');
const ejs = require('ejs');
const Haikunator = require('haikunator');
const { SourceControl, Jira } = require('jira-changelog');
const RegExpFromString = require('regexp-from-string');

const config = {
  jira: {
    api: {
      host: core.getInput('jira_host'),
      email: core.getInput('jira_email'),
      token: core.getInput('jira_token'),
    },
    baseUrl: core.getInput('jira_base_url'),
    ticketIDPattern: RegExpFromString(core.getInput('jira_ticket_id_pattern')),
    approvalStatus: ['Done', 'Closed', 'Accepted'],
    excludeIssueTypes: ['Sub-task'],
    includeIssueTypes: [],
  },
  sourceControl: {
    defaultRange: {
      from:  core.getInput('source_control_range_from'),
      to: core.getInput('source_control_range_to')
    }
  },
};



const template = `
<% tickets.all.filter((t) => !t.reverted).forEach((ticket) => { -%>
  * [<%= ticket.key %>](<%= jira.baseUrl + '/browse/' + ticket.key %>) - <%- ticket.fields.summary %>
<% }); -%>
<% if (!tickets.all.filter((t) => !t.reverted).length) {%> ~ None ~ <% } %>
`;

function generateReleaseVersionName() {
  const hasVersion = process.env.VERSION;
  if (hasVersion) {
    return process.env.VERSION;
  } else {
    const haikunator = new Haikunator();
    return haikunator.haikunate();
  }
}

function transformCommitLogs(config, logs) {
  let approvalStatus = config.jira.approvalStatus;
  if (!Array.isArray(approvalStatus)) {
    approvalStatus = [approvalStatus];
  }

  // Tickets and their commits
  const ticketHash = logs.reduce((all, log) => {
    log.tickets.forEach((ticket) => {
      all[ticket.key] = all[ticket.key] || ticket;
      all[ticket.key].commits = all[ticket.key].commits || [];
      all[ticket.key].commits.push(log);
    });
    return all;
  }, {});
  const ticketList = _.sortBy(Object.values(ticketHash), ticket => ticket.fields.issuetype.name);
  let pendingTickets = ticketList.filter(ticket => !approvalStatus.includes(ticket.fields.status.name));

  // Pending ticket owners and their tickets/commits
  const reporters = {};
  pendingTickets.forEach((ticket) => {
    const email = ticket.fields.reporter.emailAddress;
    if (!reporters[email]) {
      reporters[email] = {
        email,
        name: ticket.fields.reporter.displayName,
        slackUser: ticket.slackUser,
        tickets: [ticket]
      };
    } else {
      reporters[email].tickets.push(ticket);
    }
  });
  const pendingByOwner = _.sortBy(Object.values(reporters), item => item.user);

  // Output filtered data
  return {
    commits: {
      all: logs,
      tickets: logs.filter(commit => commit.tickets.length),
      noTickets: logs.filter(commit => !commit.tickets.length)
    },
    tickets: {
      pendingByOwner,
      all: ticketList,
      approved: ticketList.filter(ticket => approvalStatus.includes(ticket.fields.status.name)),
      pending: pendingTickets
    }
  }
}

async function main() {
  try {
    // Get commits for a range
    const source = new SourceControl(config);
    const jira = new Jira(config);

    const range = config.sourceControl.defaultRange;
    console.log(`Getting range ${range.from}...${range.to} commit logs`);
    const commitLogs = await source.getCommitLogs('./');
    console.log('Found following commit logs:');
    console.log(commitLogs);

    console.log('Generating release version');
    const release = generateReleaseVersionName();
    console.log(`Release: ${release}`);

    console.log('Generating Jira changelog from commit logs');
    const changelog = await jira.generate(commitLogs, release);
    console.log('Changelog entry:');
    console.log(changelog);

    console.log('Generating changelog message');
    const data = await transformCommitLogs(config, changelog);

    data.jira = {
      baseUrl: config.jira.baseUrl,
      releaseVersions: jira.releaseVersions,
    };

    const entitles = new Entities.AllHtmlEntities();
    const changelogMessage = ejs.render(template, data);

    console.log('Changelog message entry:');
    console.log(entitles.decode(changelogMessage));

    core.setOutput('changelog_message', changelogMessage);

  } catch (error) {
    core.setFailed(error.message);
  }
}

main();
